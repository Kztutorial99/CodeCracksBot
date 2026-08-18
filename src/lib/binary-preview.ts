const MAX_TEXT = 12000;
const MAX_HEX_BYTES = 1024;

function isMostlyText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 2048);
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable++;
  }
  return sample.length > 0 && printable / sample.length > 0.85;
}

function hexDump(bytes: Uint8Array): string {
  const lines: string[] = [];
  const limit = Math.min(bytes.length, MAX_HEX_BYTES);
  for (let offset = 0; offset < limit; offset += 16) {
    const row = bytes.subarray(offset, offset + 16);
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(row, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  return lines.join("\n");
}

function extractStrings(bytes: Uint8Array, min = 5, max = 60): string[] {
  const out: string[] = [];
  let current = "";
  for (const byte of bytes) {
    if (byte >= 32 && byte < 127) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= min) out.push(current);
      current = "";
    }
    if (out.length >= max) break;
  }
  if (current.length >= min && out.length < max) out.push(current);
  return out;
}

/** Turns an uploaded file into a compact, model-friendly description. */
export function describeFile(name: string, bytes: Uint8Array): string {
  if (isMostlyText(bytes)) {
    const text = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT));
    return `File: ${name} (${bytes.length} bytes, text)\n\n\`\`\`\n${text}\n\`\`\``;
  }
  return [
    `File: ${name} (${bytes.length} bytes, binary)`,
    "",
    "Hex dump (first bytes):",
    "```",
    hexDump(bytes),
    "```",
    "",
    "Extracted strings:",
    "```",
    extractStrings(bytes).join("\n"),
    "```",
  ].join("\n");
}
