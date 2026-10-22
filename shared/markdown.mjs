// Minimal, safe Markdown-ish renderer for forum bodies.
// Input is always escaped first; only an allow-listed subset of syntax is turned into HTML.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function sanitizeUrl(url) {
  const raw = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  if (/^\/(?!\/)/.test(raw) || raw.startsWith('#')) return raw;
  return '#';
}

function inline(text) {
  // Protect escaped entities from later passes by working on escaped text.
  let s = escapeHtml(text);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
  // bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // italic
  s = s.replace(/(^|[\s(【（])\*([^*\n]+)\*(?=$|[\s)】）。，,.;:!?！？])/g, '$1<em>$2</em>');
  // strikethrough
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // links [label](url)
  s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (_, label, url) => {
    const href = sanitizeUrl(url.replace(/&amp;/g, '&'));
    const safeHref = escapeHtml(href);
    const external = /^https?:/i.test(href) ? ' rel="nofollow ugc noopener" target="_blank"' : '';
    return `<a href="${safeHref}"${external}>${label}</a>`;
  });
  // bare urls
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]{4,300})/g, (m, pre, url) => {
    return `${pre}<a href="${escapeHtml(url)}" rel="nofollow ugc noopener" target="_blank">${escapeHtml(url)}</a>`;
  });
  return s;
}

export function renderMarkdown(source) {
  const text = String(source || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let listOpen = false;

  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code block
    const fence = line.match(/^\s*```([\w#+.-]*)\s*$/);
    if (fence) {
      closeList();
      const lang = fence[1] ? ` class="lang-${escapeAttr(fence[1])}"` : '';
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<pre><code${lang}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // table: header row + |---|---| divider + rows
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const splitRow = (row) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => inline(cell.trim()));
      const headerCells = splitRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        bodyRows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${headerCells
          .map((c) => `<th>${c}</th>`)
          .join('')}</tr></thead><tbody>${bodyRows
          .map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(heading[1].length + 2, 4); // h3..h4 inside content
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // blockquote
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      const buf = [quote[1]];
      while (i + 1 < lines.length && /^>\s?/.test(lines[i + 1])) {
        i++;
        buf.push(lines[i].replace(/^>\s?/, ''));
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // unordered list
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // ordered list
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ol) {
      closeList();
      const buf = [ol[1]];
      while (i + 1 < lines.length && /^\s*\d+[.)]\s+/.test(lines[i + 1])) {
        i++;
        buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
      }
      out.push(`<ol>${buf.map((b) => `<li>${inline(b)}</li>`).join('')}</ol>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      continue;
    }

    // paragraph: group consecutive non-empty lines
    closeList();
    const buf = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      !/^\s*(```|#{1,4}\s|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(lines[i + 1])
    ) {
      i++;
      buf.push(lines[i]);
    }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  closeList();
  return out.join('\n');
}

export function plainText(source, max = 160) {
  const s = String(source || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_~`>#]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
