import * as _TurndownService from '@joplin/turndown';
import * as TurndownPluginGfm from '@joplin/turndown-plugin-gfm';
import { getBasename } from './basename';
import { stripTableColgroups } from '../../ccc/markdown/strip-colgroup'; // CCC #145
import { collapseTableCellBreaks } from '../../ccc/markdown/table-row-breaks'; // CCC #145
import { taskItemMarkdown } from '../../ccc/markdown/task-item'; // CCC #145
import { summaryOf, turndownElement } from '../../ccc/markdown/turndown-node'; // CCC #145

// CJS/ESM interop: .default exists in Vite, not in NestJS
const TurndownService = (_TurndownService as any).default || _TurndownService;

function sanitizeMdLinkText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([\[\]!])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

export function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    hr: '---',
    bulletListMarker: '-',
  });

  turndownService.use([
    TurndownPluginGfm.tables,
    TurndownPluginGfm.strikethrough,
    TurndownPluginGfm.highlightedCodeBlock,
    taskList,
    callout,
    preserveDetail,
    listParagraph,
    orderedListItem,
    mathInline,
    mathBlock,
    iframeEmbed,
    image,
    video,
  ]);
  // CCC #145: no <colgroup> (phantom header row); cell <br> → space in table rows only (literal <br> in code survives)
  return collapseTableCellBreaks(turndownService.turndown(stripTableColgroups(html)));
}

function listParagraph(turndownService: _TurndownService) {
  turndownService.addRule('paragraph', {
    filter: ['p'],
    replacement: (content: string, node: HTMLInputElement) => {
      if (node.parentElement?.nodeName === 'LI') {
        return content;
      }
      return `\n\n${content}\n\n`;
    },
  });
}

function orderedListItem(turndownService: _TurndownService) {
  turndownService.addRule('orderedListItem', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'LI' && node.getAttribute('data-type') !== 'taskItem';
    },
    replacement: (content: string, node: HTMLInputElement, options: any) => {
      const parent = node.parentNode as HTMLElement;
      if (parent.nodeName !== 'OL' && parent.nodeName !== 'UL') {
        return content;
      }

      content = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, '\n  ');

      let prefix: string;
      if (parent.nodeName === 'OL') {
        const start = parseInt(parent.getAttribute('start') || '1', 10);
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start + index}. `;
      } else {
        prefix = `${options.bulletListMarker} `;
      }

      return (
        prefix +
        content +
        (node.nextSibling && !/\n$/.test(content) ? '\n' : '')
      );
    },
  });
}

function callout(turndownService: _TurndownService) {
  turndownService.addRule('callout', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' && node.getAttribute('data-type') === 'callout'
      );
    },
    replacement: function (content: string, node: HTMLInputElement) {
      const calloutType = node.getAttribute('data-callout-type');
      return `\n\n:::${calloutType}\n${content.trim()}\n:::\n\n`;
    },
  });
}

function taskList(turndownService: _TurndownService) {
  turndownService.addRule('taskListItem', {
    filter: function (node: HTMLInputElement) {
      return (
        node.getAttribute('data-type') === 'taskItem' &&
        node.parentNode.nodeName === 'UL'
      );
    },
    replacement: function (content: string, node: HTMLInputElement) {
      const isChecked = node.getAttribute('data-checked') === 'true';
      const text = taskItemMarkdown(content); // CCC #145: keep links, code, marks, nested tasks

      const prefix = `- ${isChecked ? '[x]' : '[ ]'} `;

      return (
        prefix +
        text +
        (node.nextSibling && !/\n$/.test(text) ? '\n' : '')
      );
    },
  });
}

function preserveDetail(turndownService: _TurndownService) {
  turndownService.addRule('preserveDetail', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'DETAILS';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const summary = summaryOf(node); // CCC #145: no selector query (keeps the jsdom alive)
      let detailSummary = '';

      if (summary) {
        detailSummary = `<summary>${turndownService.turndown(summary as HTMLElement)}</summary>`; // CCC #145: a node, no new JSDOM
      }

      const detailsContent = Array.from(node.childNodes)
        .filter((child) => child.nodeName !== 'SUMMARY')
        .map((child) =>
          child.nodeType === 1
            ? turndownElement(turndownService, child as HTMLElement) // CCC #145: a node, no new JSDOM
            : child.textContent,
        )
        .join('');

      return `\n<details>\n${detailSummary}\n\n${detailsContent}\n\n</details>\n`;
    },
  });
}

function mathInline(turndownService: _TurndownService) {
  turndownService.addRule('mathInline', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'SPAN' &&
        node.getAttribute('data-type') === 'mathInline'
      );
    },
    replacement: function (content: string) {
      return `$${content}$`;
    },
  });
}

function mathBlock(turndownService: _TurndownService) {
  turndownService.addRule('mathBlock', {
    filter: function (node: HTMLInputElement) {
      return (
        node.nodeName === 'DIV' &&
        node.getAttribute('data-type') === 'mathBlock'
      );
    },
    replacement: function (content: string) {
      return `\n$$\n${content}\n$$\n`;
    },
  });
}

function iframeEmbed(turndownService: _TurndownService) {
  turndownService.addRule('iframeEmbed', {
    filter: function (node: HTMLInputElement) {
      return node.nodeName === 'IFRAME';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src');
      return '[' + src + '](' + src + ')';
    },
  });
}

function image(turndownService: _TurndownService) {
  turndownService.addRule('image', {
    filter: 'img',
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      if (!src) return '';
      const alt = sanitizeMdLinkText(node.getAttribute('alt') || '');
      const title = node.getAttribute('title') || '';
      const titlePart = title ? ' "' + title.replace(/"/g, '\\"') + '"' : '';
      return '![' + alt + '](' + src + titlePart + ')';
    },
  });
}

function video(turndownService: _TurndownService) {
  turndownService.addRule('video', {
    filter: function (node: HTMLInputElement) {
      return node.tagName === 'VIDEO';
    },
    replacement: function (_content: string, node: HTMLInputElement) {
      const src = node.getAttribute('src') || '';
      const ariaLabel = node.getAttribute('aria-label');
      const name = sanitizeMdLinkText(
        ariaLabel || getBasename(src) || src,
      );
      return '[' + name + '](' + src + ')';
    },
  });
}
