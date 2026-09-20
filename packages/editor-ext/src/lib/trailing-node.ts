import { Extension } from '@tiptap/core'
import { PluginKey, Plugin, type Transaction } from '@tiptap/pm/state';

export interface TrailingNodeExtensionOptions {
  node: string,
  notAfter: string[],
  // #345: return false to skip inserting the trailing node for a transaction. The client injects
  // `(t) => !isChangeOrigin(t)` so an open browser never appends a trailing paragraph in reaction to content
  // that arrived over the collaboration sync (API/MCP/another client) — which would rewrite that content and
  // rotate its version anchor. Mirrors the guard on UniqueID. Undefined (the default) is a pass-all filter,
  // NOT the full pre-#345 behavior: the insert also now requires a `docChanged` transaction in the batch
  // (see appendTransaction), so a selection-only transaction no longer triggers it even with no filter.
  filterTransaction?: (tr: Transaction) => boolean,
}

function nodeEqualsType({ types, node }: { types: any, node: any }) {
  return (Array.isArray(types) && types.includes(node.type)) || node.type === types
}

// @ts-ignore
/**
 * Extension based on:
 * - https://github.com/ueberdosis/tiptap/blob/v1/packages/tiptap-extensions/src/extensions/TrailingNode.js
 * - https://github.com/remirror/remirror/blob/e0f1bec4a1e8073ce8f5500d62193e52321155b9/packages/prosemirror-trailing-node/src/trailing-node-plugin.ts
 */
export const TrailingNode = Extension.create<TrailingNodeExtensionOptions>({
  name: 'trailingNode',

  addOptions() {
    return {
      node: 'paragraph',
      notAfter: [
        'paragraph',
      ],
    };
  },

  addProseMirrorPlugins() {
    const plugin = new PluginKey(this.name)
    const disabledNodes = Object.entries(this.editor.schema.nodes)
      .map(([, value]) => value)
      .filter(node => this.options.notAfter.includes(node.name))
    const passes = this.options.filterTransaction ?? (() => true)

    return [
      new Plugin({
        key: plugin,
        appendTransaction: (transactions, __, state) => {
          const { doc, tr, schema } = state;
          const shouldInsertNodeAtEnd = plugin.getState(state);
          const endPosition = doc.content.size;
          const type = schema.nodes[this.options.node]

          if (!shouldInsertNodeAtEnd) {
            return;
          }

          // #345: append only when a LOCAL doc change drove this batch. A purely remote/sync (change-origin)
          // change — or a mere click/selection on a page nobody is editing — must not rewrite content
          // authored elsewhere by appending a trailing paragraph and re-persisting it.
          if (!transactions.some((t) => t.docChanged && passes(t))) {
            return;
          }

          return tr.insert(endPosition, type.create());
        },
        state: {
          init: (_, state) => {
            try {
              const lastNode = state.tr.doc.lastChild
              return !nodeEqualsType({ node: lastNode, types: disabledNodes })
            } catch (err){
              console.log(err)
            }
            return true;
          },
          apply: (tr, value) => {
            if (!tr.docChanged) {
              return value
            }

            // Ignore transactions from UniqueID extension to prevent infinite loops
            // when UniqueID adds IDs to newly inserted trailing nodes
            if (tr.getMeta('__uniqueIDTransaction')) {
              return value
            }

            const lastNode = tr.doc.lastChild
            return !nodeEqualsType({ node: lastNode, types: disabledNodes })
          },
        },
      }),
    ]
  }
})
