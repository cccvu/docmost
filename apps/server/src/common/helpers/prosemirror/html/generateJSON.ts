import type { Extensions } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { type ParseOptions, DOMParser as PMDOMParser } from '@tiptap/pm/model';
import {
  type IFetchInterceptor,
  type IOptionalBrowserSettings,
  Window,
} from 'happy-dom';

/**
 * CCC #621: the parse window must never reach the network.
 *
 * The HTML parsed here is untrusted (`/v1` page writes, MCP page tools, imports), and happy-dom loads what a
 * browser would load: a connected `<iframe src>` navigates, a `<link rel=stylesheet|preload>` fetches, and an
 * `<iframe srcdoc>` does both again in a child frame. Closing the window after the parse only races those
 * requests; it does not stop them. So every loader is switched off, and the fetch layer that all of them share
 * refuses whatever still reaches it. None of this changes how the DOM is built, so the ProseMirror output is
 * the same.
 */
const DENY_ALL_FETCH: IFetchInterceptor = {
  // Resolve to a network error: no socket is opened, and happy-dom's own task bookkeeping stays balanced.
  beforeAsyncRequest: async ({ window }) => window.Response.error(),
  beforeSyncRequest: ({ request }) => {
    throw new Error(
      `Network access is disabled for HTML parsing: ${request.url}`,
    );
  },
};

const networkIsolatedSettings = (): IOptionalBrowserSettings => ({
  // No inline <script>, on* handler or javascript: URL runs. This is already the 20.x default; pinned here.
  enableJavaScriptEvaluation: false,
  // <script src>, <link rel=modulepreload>, <link rel=preload as=script>.
  disableJavaScriptFileLoading: true,
  // <link rel=stylesheet>, <link rel=preload as=style>.
  disableCSSFileLoading: true,
  // <iframe src>. Marked deprecated, but it is the flag HTMLIFrameElement still checks in happy-dom 20.x.
  disableIframePageLoading: true,
  navigation: {
    disableMainFrameNavigation: true,
    // The non-deprecated spelling of the iframe gate above.
    disableChildFrameNavigation: true,
    disableChildPageNavigation: true,
    // A refused navigation does not change the frame's URL either.
    disableFallbackToSetURL: true,
  },
  fetch: { interceptor: DENY_ALL_FETCH },
});

/** A happy-dom window that cannot make a network request. Close it with `happyDOM.close()` when done. */
export function createNetworkIsolatedWindow(): Window {
  return new Window({ settings: networkIsolatedSettings() });
}

/**
 * Generates a JSON object from the given HTML string and converts it into a Prosemirror node with content.
 * @remarks **Important**: This function requires `happy-dom` to be installed in your project.
 * @param {string} html - The HTML string to be converted into a Prosemirror node.
 * @param {Extensions} extensions - The extensions to be used for generating the schema.
 * @param {ParseOptions} options - The options to be supplied to the parser.
 * @returns {Promise<Record<string, any>>} - A promise with the generated JSON object.
 * @example
 * const html = '<p>Hello, world!</p>'
 * const extensions = [...]
 * const json = generateJSON(html, extensions)
 * console.log(json) // { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello, world!' }] }] }
 */
export function generateJSON(
  html: string,
  extensions: Extensions,
  options?: ParseOptions,
): Record<string, any> {
  if (typeof window !== 'undefined') {
    throw new Error(
      'generateJSON can only be used in a Node environment\nIf you want to use this in a browser environment, use the `@tiptap/html` import instead.',
    );
  }

  const localWindow = createNetworkIsolatedWindow();
  const localDOMParser = new localWindow.DOMParser();
  let result: Record<string, any>;

  try {
    const schema = getSchema(extensions);
    let doc: ReturnType<typeof localDOMParser.parseFromString> | null = null;

    const htmlString = `<!DOCTYPE html><html><body>${html}</body></html>`;
    doc = localDOMParser.parseFromString(htmlString, 'text/html');

    if (!doc) {
      throw new Error('Failed to parse HTML string');
    }

    result = PMDOMParser.fromSchema(schema)
      .parse(doc.body as unknown as Node, options)
      .toJSON();
  } finally {
    // clean up happy-dom to avoid memory leaks
    localWindow.happyDOM.abort();
    localWindow.happyDOM.close();
  }

  return result;
}
