// This browser's id for hold_run and hold_prepare: the same in every tab and after a reload, so reopening the page
// carries on with what this browser was doing. Browser only.

let memo: string | undefined;

export function runnerId() {
  try {
    let id = localStorage.getItem("vt-runner");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("vt-runner", id);
    }
    return id;
  } catch {
    return (memo ??= crypto.randomUUID());
  }
}
