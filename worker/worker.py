#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests", "anthropic", "boto3"]
# ///
"""
worker.py - does the web app's jobs on this Mac.

It only makes outgoing connections: it asks the database for work, downloads the video from storage,
runs the pipeline in scripts/vt.py, and uploads the results.

  uv run worker/worker.py            # run until stopped
  uv run worker/worker.py --once     # do the jobs that are waiting, then exit

Settings come from worker/.env (see worker/.env.example). install-service.sh makes it start at login.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import vt  # noqa: E402

VERSION = "1"
POLL_SECONDS = 10        # how often to ask for work when idle (this also tells the app "I'm online")
LEASE_SECONDS = 120      # a job whose worker is silent this long goes back to the queue
KEEP_DAYS = 7            # job folders are kept this long, so re-running a language reuses the voice audio


def say(msg: str):
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}", flush=True)


def load_env_file(path: Path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            if v.strip() and not os.environ.get(k.strip()):
                os.environ[k.strip()] = v.strip().strip('"').strip("'")


def need(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"{name} is not set - put it in {HERE / '.env'} (see .env.example)")
    return v


class Canceled(Exception):
    """The person canceled the job (or it was taken away) while we were working on it."""


# ----------------------------------------------------------------------------- database (Supabase REST)

class Database:
    def __init__(self):
        self.url = need("SUPABASE_URL").rstrip("/")
        key = need("SUPABASE_SECRET_KEY")
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}"})

    def rpc(self, fn: str, **args):
        r = self.s.post(f"{self.url}/rest/v1/rpc/{fn}", json=args, timeout=30)
        if r.status_code >= 400:
            raise RuntimeError(f"{fn} failed ({r.status_code}): {r.text[:300]}")
        return r.json() if r.content else None

    def profile(self, user_id: str) -> dict:
        r = self.s.get(f"{self.url}/rest/v1/profiles", timeout=30,
                       params={"id": f"eq.{user_id}", "select": "voice_id,voice_ids"})
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else {}


# ----------------------------------------------------------------------------- storage (Cloudflare R2)

class Storage:
    def __init__(self):
        import boto3
        from botocore.config import Config

        endpoint = os.environ.get("R2_ENDPOINT") or f"https://{need('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com"
        self.bucket = need("R2_BUCKET")
        self.s3 = boto3.client(
            "s3", endpoint_url=endpoint, region_name="auto",
            aws_access_key_id=need("R2_ACCESS_KEY_ID"), aws_secret_access_key=need("R2_SECRET_ACCESS_KEY"),
            config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 5, "mode": "standard"},
                          request_checksum_calculation="when_required",
                          response_checksum_validation="when_required"))

    def download(self, key: str, dest: Path, progress):
        from botocore.exceptions import ClientError
        try:
            total = self.s3.head_object(Bucket=self.bucket, Key=key)["ContentLength"]
        except ClientError as e:
            if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
                raise vt.VTError("the uploaded video is no longer in storage (files are removed after 30 days) - "
                                 "upload it again") from None
            raise
        tmp = dest.with_suffix(dest.suffix + ".part")
        self.s3.download_file(self.bucket, key, str(tmp), Callback=progress(total))
        tmp.rename(dest)

    def upload(self, path: Path, key: str, progress):
        self.s3.upload_file(str(path), self.bucket, key, ExtraArgs={"ContentType": "video/mp4"},
                            Callback=progress(path.stat().st_size))


# ----------------------------------------------------------------------------- heartbeat

class Heartbeat(threading.Thread):
    """While a job runs: keeps its lease, sends the latest progress, and notices when it was canceled."""

    def __init__(self, worker_id: str, job_id: str):
        super().__init__(daemon=True)
        self.db = Database()  # its own connection: requests sessions aren't shared between threads
        self.worker_id, self.job_id = worker_id, job_id
        self.progress: dict | None = None
        self.dirty = False
        self.canceled = threading.Event()
        self.stopped = threading.Event()

    def run(self):
        last = 0.0
        while not self.stopped.wait(3):
            if not (self.dirty or time.time() - last >= 30):
                continue
            self.dirty = False
            try:
                ok = self.db.rpc("worker_heartbeat", p_worker=self.worker_id, p_job=self.job_id,
                                 p_progress=self.progress, p_lease_seconds=LEASE_SECONDS, p_version=VERSION)
                if ok is False:
                    self.canceled.set()
            except Exception as e:  # a network blip must not kill the job
                say(f"heartbeat failed: {e}")
            last = time.time()

    def set(self, **progress):
        self.progress = {k: v for k, v in progress.items() if v is not None}
        self.dirty = True

    def check(self):
        if self.canceled.is_set():
            raise Canceled()


# ----------------------------------------------------------------------------- one job

class Job:
    def __init__(self, db: Database, store: Storage, worker_id: str, root: Path, row: dict):
        self.db, self.store, self.worker_id, self.row = db, store, worker_id, row
        self.id = row["id"]
        self.dir = root / self.id
        self.beat = Heartbeat(worker_id, self.id)

    # --- progress -----------------------------------------------------------------------------

    def on_event(self, ev: dict):
        """Every progress event from vt.py lands here."""
        self.beat.check()
        if ev.get("usage"):
            u = dict(ev["usage"])
            try:
                self.db.rpc("worker_usage", p_job=self.id, p_service=u.pop("service"), p_amounts=u)
            except Exception as e:
                say(f"couldn't record usage: {e}")
        if ev.get("msg"):
            say(f"  {ev['msg']}")
        if ev.get("stage") and ev["stage"] != "done":
            self.beat.set(stage=ev["stage"], lang=ev.get("lang"), done=ev.get("done"), total=ev.get("total"))

    def transfer(self, stage: str, lang: str | None = None):
        """Progress callback factory for downloads and uploads (boto3 calls it with byte counts)."""
        def start(total: int):
            seen = 0

            def cb(n: int):
                nonlocal seen
                seen += n
                self.beat.set(stage=stage, lang=lang, done=seen, total=total)
            return cb
        return start

    # --- files --------------------------------------------------------------------------------

    def setup_folder(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        if not any(p.suffix.lower() in (".mp4", ".mov", ".m4v") for p in self.dir.iterdir()):
            ext = Path(self.row.get("source_filename") or "").suffix.lower()
            dest = self.dir / f"source{ext if ext in ('.mp4', '.mov', '.m4v') else '.mp4'}"
            say(f"  downloading the video ({(self.row.get('source_bytes') or 0) / 1e6:.0f} MB)...")
            self.store.download(self.row["source_key"], dest, self.transfer("download"))
            self.beat.check()
        # per-job settings for vt.py: this person's languages and voice
        prof = self.db.profile(self.row["user_id"])
        lines = [f"languages = {json.dumps(self.row.get('languages') or [])}"]
        voices = {k: v for k, v in (prof.get("voice_ids") or {}).items() if v}
        if prof.get("voice_id") or voices:
            lines.append("[elevenlabs]")
            if prof.get("voice_id"):
                lines.append(f"voice_id = {json.dumps(prof['voice_id'])}")
            if voices:
                lines.append("voice_ids = { " + ", ".join(f"{k} = {json.dumps(v)}" for k, v in voices.items()) + " }")
        (self.dir / "job.toml").write_text("\n".join(lines) + "\n")

    # --- the two halves ---------------------------------------------------------------------

    def prepare(self):
        if self.row.get("reference"):
            (self.dir / "reference.txt").write_text(self.row["reference"])
        r = vt.prepare(self.dir, self.row.get("base_lang"))
        self.db.rpc("worker_prepared", p_worker=self.worker_id, p_job=self.id, p_base_lang=r["base_lang"],
                    p_script="\n\n".join(r["beats"]), p_names_fixed=r["names_fixed"], p_warnings=r["warnings"])
        say("  ready for review")

    def produce(self):
        script = self.dir / "script.txt"
        wanted = vt.split_beats(self.row.get("script") or "")
        if wanted and (not script.exists() or vt.split_beats(script.read_text()) != wanted):
            script.write_text("\n\n".join(wanted) + "\n")  # the person's edits from the review step
        if not (self.dir / "work" / "analysis.json").exists():  # e.g. the folder was cleaned up since
            vt.prepare(self.dir, self.row.get("base_lang"))

        langs = [l for l in self.row.get("languages") or [] if l != self.row.get("base_lang")]
        if not langs:
            raise vt.VTError("no languages to translate into")
        errors, done = [], 0
        for lang in langs:
            self.beat.check()
            self.output(lang, "running")
            try:
                # one language at a time, so a problem with one doesn't stop the others
                res = vt.produce(self.dir, [lang], preview=True)[0]
            except vt.VTError as e:
                say(f"  {lang} failed: {e}")
                errors.append(f"{lang}: {e}")
                self.output(lang, "failed", p_flags=[str(e)])
                continue
            base = f"u/{self.row['user_id']}/{self.id}/out/{lang}"
            out, prev = Path(res["output"]), Path(res["preview"])
            say(f"  {lang}: uploading ({out.stat().st_size / 1e6:.0f} MB)...")
            self.store.upload(prev, f"{base}_preview.mp4", self.transfer("upload", lang))
            self.store.upload(out, f"{base}.mp4", self.transfer("upload", lang))
            self.output(lang, "done", p_seconds=res["seconds"], p_flags=res["flags"],
                        p_report=Path(res["report"]).read_text(), p_output_key=f"{base}.mp4",
                        p_output_bytes=out.stat().st_size, p_preview_key=f"{base}_preview.mp4")
            out.unlink()  # the full-size file is in storage now; the rest of the folder stays for re-runs
            done += 1
        # every language failed -> the job failed; some failed -> done, with those marked failed
        self.finish(None if done else errors[0])

    def output(self, lang: str, status: str, **fields):
        self.db.rpc("worker_output", p_worker=self.worker_id, p_job=self.id, p_lang=lang, p_status=status, **fields)

    def finish(self, error: str | None):
        for attempt in range(5):  # the result must reach the database, or the job would be redone
            try:
                self.db.rpc("worker_finish", p_worker=self.worker_id, p_job=self.id, p_error=error)
                return
            except Exception as e:
                say(f"couldn't report the result (try {attempt + 1}): {e}")
                time.sleep(5)

    # --- run ----------------------------------------------------------------------------------

    def run(self):
        say(f"job {self.id} \"{self.row.get('name')}\": {self.row['status']}")
        awake = keep_awake()
        self.beat.start()
        vt.set_reporter(self.on_event)
        try:
            self.setup_folder()
            if self.row["status"] == "preparing":
                self.prepare()
            else:
                self.produce()
                say("  finished")
        except Canceled:
            say("  canceled - stopped working on it")
        except vt.VTError as e:
            say(f"  failed: {e}")
            self.finish(str(e))
        except Exception as e:
            traceback.print_exc()
            self.finish(f"Something unexpected went wrong on the worker ({type(e).__name__}). "
                        f"The details are in the worker's log.")
        finally:
            vt.set_reporter(None)
            self.beat.stopped.set()
            self.beat.join(timeout=10)
            if awake:
                awake.terminate()


def keep_awake():
    """Stop the Mac from going to sleep while a job runs (WORKER_KEEP_AWAKE=off to disable)."""
    if os.environ.get("WORKER_KEEP_AWAKE", "job") == "off" or not shutil.which("caffeinate"):
        return None
    return subprocess.Popen(["caffeinate", "-i", "-w", str(os.getpid())])


def clean_up(root: Path):
    """Delete job folders nobody touched for KEEP_DAYS."""
    limit = time.time() - KEEP_DAYS * 86400
    for d in root.iterdir():
        if d.is_dir() and len(d.name) == 36 and d.stat().st_mtime < limit:
            newest = max((p.stat().st_mtime for p in d.rglob("*")), default=0)
            if newest < limit:
                say(f"removing old job folder {d.name}")
                shutil.rmtree(d, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--once", action="store_true", help="do the waiting jobs, then exit")
    a = ap.parse_args()

    load_env_file(HERE / ".env")
    root = Path(os.environ.get("VT_WORKER_DIR") or "~/Library/Application Support/Video Translator Worker").expanduser()
    root.mkdir(parents=True, exist_ok=True)
    os.environ["VT_JOBS_DIR"] = str(root)  # a config.toml there applies to every job
    vt.load_env()
    try:
        vt.check_tools()
    except vt.VTError as e:
        sys.exit(str(e))
    for name in ("ELEVENLABS_API_KEY", "ANTHROPIC_API_KEY"):
        need(name)

    worker_id = os.environ.get("WORKER_ID") or socket.gethostname().split(".")[0]
    db, store = Database(), Storage()
    say(f"worker \"{worker_id}\" started; job folders in {root}")
    last_clean = 0.0
    while True:
        try:
            row = db.rpc("worker_claim", p_worker=worker_id, p_lease_seconds=LEASE_SECONDS, p_version=VERSION)
        except Exception as e:
            say(f"couldn't reach the database: {e}")
            row = None
        if row and row.get("id"):
            Job(db, store, worker_id, root, row).run()
            continue  # ask again straight away
        if a.once:
            return
        if time.time() - last_clean > 3600:
            clean_up(root)
            last_clean = time.time()
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
