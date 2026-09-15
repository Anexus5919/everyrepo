import type { RepoView } from "@everyrepo/core/requests";
import { h } from "./dom.ts";
import { etaSentence, statusCopy, statusHref } from "./repo-status.ts";

let dialog: HTMLDialogElement | undefined;

// Explains the one request rule and points to the request the person is already waiting on
export function showOneRequestNotice(active: RepoView | null, message: string): void {
  dialog?.remove();
  const now = Date.now();
  const copy = active ? statusCopy(active, now) : null;
  const eta = active ? etaSentence(active, now) : "";
  const close = h("button", { class: "btn btn-line", type: "button" }, "Close");

  dialog = h(
    "dialog",
    {
      class: "notice-dialog",
      "aria-labelledby": "notice-title",
      "aria-describedby": "notice-text",
    },
    h(
      "div",
      // Focus lands on the window itself, so no control looks selected when it opens
      { class: "notice-shell", tabindex: -1, autofocus: true },
      h("span", { class: "notice-emoji", role: "img", "aria-label": "Hourglass" }, "⏳"),
      h("h2", { id: "notice-title" }, "One request at a time"),
      h("p", { id: "notice-text", class: "notice-text" }, message),
      active
        ? h(
            "a",
            { class: "notice-active", href: statusHref(active.repo) },
            h("span", { class: "notice-label" }, "Your request"),
            h("span", { class: "notice-repo" }, active.repo),
            copy ? h("span", { class: "notice-state" }, copy.title) : null,
            eta ? h("span", { class: "notice-eta" }, eta) : null,
          )
        : null,
      h(
        "p",
        { class: "notice-hint" },
        "You can request another repository as soon as this one is ready.",
      ),
      h(
        "div",
        { class: "notice-actions" },
        active
          ? h("a", { class: "btn btn-solid", href: statusHref(active.repo) }, "Follow your request")
          : null,
        close,
      ),
    ),
  );
  close.addEventListener("click", () => dialog?.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog?.close();
  });
  dialog.addEventListener("close", () => {
    document.documentElement.classList.remove("has-notice");
    dialog?.remove();
    dialog = undefined;
  });
  document.body.append(dialog);
  // The request window closes first, so only one window is open at a time
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((open) => {
    if (open !== dialog) open.close();
  });
  document.documentElement.classList.add("has-notice");
  dialog.showModal();
}
