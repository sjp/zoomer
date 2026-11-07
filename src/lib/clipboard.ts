/**
 * Copying text to the clipboard. The async clipboard API exists only in secure
 * contexts (https, or http on localhost), so a page opened over plain http on
 * another host, such as a dev container's address, falls back to the older
 * `execCommand("copy")` on a hidden, selected textarea, which still works
 * there from a click.
 */

/** What copying needs from the browser, so tests can stand in for it. */
export interface ClipboardEnv {
  /** `navigator.clipboard.writeText`, when the page has it. */
  writeText?: ((text: string) => Promise<void>) | undefined;
  /** Copies `text` the old way; returns whether the browser says it did. */
  legacyCopy: (text: string) => boolean;
}

/** Copies via a hidden, selected textarea and `execCommand("copy")`. */
export function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Out of sight and out of the layout, but still selectable.
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  const focused = document.activeElement;
  document.body.append(area);
  try {
    area.select();
    // Deprecated, but the only way to copy outside a secure context.
    // oxlint-disable-next-line typescript/no-deprecated
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) {
      focused.focus();
    }
  }
}

function browserEnv(): ClipboardEnv {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  return {
    // Missing outside secure contexts, though typed as always there.
    writeText: clipboard?.writeText ? (text) => clipboard.writeText(text) : undefined,
    legacyCopy,
  };
}

/** Copies `text`, trying the clipboard API then the old way. Resolves to whether either worked. */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (env.writeText) {
    try {
      await env.writeText(text);
      return true;
    } catch {
      // Refused (no focus, or a frame without permission): try the old way.
    }
  }
  return env.legacyCopy(text);
}
