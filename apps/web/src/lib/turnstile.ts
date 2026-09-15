// The person check runs only when the build names a site key; the request API checks the token it returns

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  execute(widget: string): void;
  reset(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SITE_KEY = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface Pending {
  resolve(token: string): void;
  reject(error: Error): void;
}

let loading: Promise<TurnstileApi> | undefined;
// One widget per form, reused for every submit from it
const widgets = new WeakMap<HTMLElement, { id: string; pending?: Pending | undefined }>();

function load(): Promise<TurnstileApi> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("unavailable"));
    script.onerror = () => reject(new Error("unavailable"));
    document.head.append(script);
  });
  return loading;
}

export const turnstileEnabled = Boolean(SITE_KEY);

// Starts loading early, for example when someone focuses the form, so the check is ready on submit
export function prepareTurnstile(): void {
  if (SITE_KEY) void load().catch(() => {});
}

export async function turnstileToken(container: HTMLElement): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  const api = await load().catch(() => {
    throw new Error("The person check could not load. Check your connection and try again.");
  });
  let entry = widgets.get(container);
  if (!entry) {
    const created: { id: string; pending?: Pending | undefined } = { id: "" };
    created.id = api.render(container, {
      sitekey: SITE_KEY,
      appearance: "interaction-only",
      execution: "execute",
      callback: (token: string) => {
        created.pending?.resolve(token);
        created.pending = undefined;
        api.reset(created.id);
      },
      "error-callback": () => {
        created.pending?.reject(new Error("The person check did not pass. Try again."));
        created.pending = undefined;
      },
    });
    widgets.set(container, created);
    entry = created;
  }
  const widget = entry;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      widget.pending = undefined;
      reject(new Error("The person check took too long. Try again."));
    }, 60_000);
    widget.pending = {
      resolve: (token) => {
        clearTimeout(timeout);
        resolve(token);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    };
    api.execute(widget.id);
  });
}
