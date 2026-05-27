// Shared zero-dependency xlsx + csv parser. No external libraries required.

export interface ParseResult {
  rows:  Record<string, string>[];  // keys are lowercased, spaces/underscores stripped
  error: string | null;
}

// ─── ZIP / XLSX internals ─────────────────────────────────────────────────────

async function readZipEntry(buffer: ArrayBuffer, filename: string): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);
  let offset  = 0;

  while (offset < bytes.length - 4) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;

    const flags          = view.getUint16(offset + 6,  true);
    const compression    = view.getUint16(offset + 8,  true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen        = view.getUint16(offset + 26, true);
    const extraLen       = view.getUint16(offset + 28, true);
    const name           = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLen));
    const dataStart      = offset + 30 + nameLen + extraLen;
    const dataEnd        = dataStart + compressedSize;

    if (name === filename) {
      const compressed = bytes.slice(dataStart, dataEnd);
      if (compression === 0) return new TextDecoder().decode(compressed);
      if (compression === 8) {
        const ds     = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(compressed);
        writer.close();
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
          const { value, done: d } = await reader.read();
          if (value) chunks.push(value);
          done = d;
        }
        const total  = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(total);
        let pos = 0;
        for (const c of chunks) { merged.set(c, pos); pos += c.length; }
        return new TextDecoder().decode(merged);
      }
    }

    const descriptorExtra = (flags & 0x0008) ? 12 : 0;
    offset = dataEnd + descriptorExtra;
  }
  return null;
}

function parseXmlText(xml: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, "gs");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) results.push(m[1]);
  return results;
}

function stripXmlTags(s: string): string {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

function cellColIndex(cellXml: string): number {
  const rAttr = cellXml.match(/r="([A-Z]+)\d+"/);
  if (!rAttr) return 0;
  const col = rAttr[1];
  let idx = 0;
  for (let i = 0; i < col.length; i++) idx = idx * 26 + (col.charCodeAt(i) - 64);
  return idx - 1;
}

async function parseXlsxBuffer(buffer: ArrayBuffer): Promise<ParseResult> {
  try {
    const sharedXml     = await readZipEntry(buffer, "xl/sharedStrings.xml");
    const sharedStrings: string[] = [];
    if (sharedXml) {
      const siMatches = sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
      for (const si of siMatches) {
        sharedStrings.push(stripXmlTags(si.replace(/<si>/g, "").replace(/<\/si>/g, "")));
      }
    }

    const sheetXml = await readZipEntry(buffer, "xl/worksheets/sheet1.xml");
    if (!sheetXml) return { rows: [], error: "Could not read sheet1 from the Excel file." };

    const rowMatches = sheetXml.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? [];
    if (rowMatches.length < 2) return { rows: [], error: "File has no data rows." };

    const headerRow     = rowMatches[0] ?? "";
    const cellsInHeader = headerRow.match(/<c\b[^>]*>[\s\S]*?<\/c>/g) ?? [];
    const rawHeaders    = cellsInHeader.map(cell => {
      const tAttr  = cell.match(/t="([^"]+)"/);
      const vMatch = parseXmlText(cell, "v");
      const raw    = vMatch[0] ?? "";
      if (tAttr?.[1] === "s")         return sharedStrings[parseInt(raw)] ?? raw;
      if (tAttr?.[1] === "inlineStr") return stripXmlTags(parseXmlText(cell, "t")[0] ?? "");
      return stripXmlTags(raw);
    });
    const normalHeaders = rawHeaders.map(h => h.trim().toLowerCase().replace(/[_\s]+/g, ""));

    const dataRows: Record<string, string>[] = [];
    for (let ri = 1; ri < rowMatches.length; ri++) {
      const cells  = rowMatches[ri].match(/<c\b[^>]*>[\s\S]*?<\/c>/g) ?? [];
      const rowObj: Record<string, string> = {};
      for (let ci = 0; ci < cells.length; ci++) {
        const cell   = cells[ci];
        const tAttr  = cell.match(/t="([^"]+)"/);
        const vMatch = parseXmlText(cell, "v");
        const raw    = vMatch[0] ?? "";
        let value: string;
        if (tAttr?.[1] === "s")         value = sharedStrings[parseInt(raw)] ?? "";
        else if (tAttr?.[1] === "inlineStr") value = stripXmlTags(parseXmlText(cell, "t")[0] ?? "");
        else                            value = stripXmlTags(raw);
        const colIdx = cellColIndex(cell);
        const hdr    = normalHeaders[colIdx] ?? normalHeaders[ci];
        if (hdr) rowObj[hdr] = value;
      }
      if (Object.keys(rowObj).length > 0) dataRows.push(rowObj);
    }

    return { rows: dataRows, error: null };
  } catch (err) {
    return { rows: [], error: `Failed to parse .xlsx: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCsvText(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { rows: [], error: "CSV has no data rows." };
  const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/[_\s]+/g, ""));
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx]?.trim() ?? ""; });
    if (Object.values(row).some(v => v)) rows.push(row);
  }
  return { rows, error: null };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseFile(file: File): Promise<ParseResult> {
  if (file.name.match(/\.csv$/i)) {
    const text = await file.text();
    return parseCsvText(text);
  }
  if (file.name.match(/\.xlsx$/i)) {
    const buffer = await file.arrayBuffer();
    return parseXlsxBuffer(buffer);
  }
  return { rows: [], error: "Only .xlsx and .csv files are supported." };
}
