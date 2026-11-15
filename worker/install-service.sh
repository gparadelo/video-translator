#!/bin/zsh
# Makes the worker start when you log in and restart if it stops.
#   worker/install-service.sh            install and start
#   worker/install-service.sh remove     stop and remove
# Log: ~/Library/Logs/video-translator-worker.log
set -e
LABEL=com.videotranslator.worker
PLIST=~/Library/LaunchAgents/$LABEL.plist
REPO=${0:A:h:h}
LOG=~/Library/Logs/video-translator-worker.log

launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null || true
if [[ $1 == remove ]]; then
  rm -f $PLIST
  echo "removed"
  exit 0
fi

UV=$(command -v uv) || { echo "uv not found - brew install uv"; exit 1 }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found - brew install ffmpeg"; exit 1 }
[[ -f $REPO/worker/.env ]] || { echo "create $REPO/worker/.env first (see worker/.env.example)"; exit 1 }

mkdir -p ~/Library/LaunchAgents
cat > $PLIST <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$UV</string><string>run</string><string>--quiet</string><string>$REPO/worker/worker.py</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${UV:h}:${$(command -v ffmpeg):h}:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
launchctl bootstrap gui/$(id -u) $PLIST
echo "worker installed and started. Log: $LOG"
