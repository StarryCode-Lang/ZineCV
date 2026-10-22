// Browser-side, owned synthetic two-page JPEG-only PDF; no text operators.
export function syntheticScannedPdfBytes() {
  const images = [];
  for (const lines of [["SCANNED OWNER", "Education", "Example University"], ["Skills", "SECOND PAGE Python", "fixture@example.invalid"]]) {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 500;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, 900, 500);
    context.fillStyle = "black"; context.font = "38px Arial";
    lines.forEach((line, index) => context.fillText(line, 40, 80 + index * 65));
    images.push(Uint8Array.from(atob(canvas.toDataURL("image/jpeg", 0.95).split(",")[1]), character => character.charCodeAt(0)));
  }
  const encode = text => new TextEncoder().encode(text);
  const stream = "q 900 0 0 500 0 0 cm /Im Do Q";
  const objects = [
    [encode("<< /Type /Catalog /Pages 2 0 R >>")],
    [encode("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>")],
    [encode("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 500] /Resources << /XObject << /Im 7 0 R >> >> /Contents 5 0 R >>")],
    [encode("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 500] /Resources << /XObject << /Im 8 0 R >> >> /Contents 6 0 R >>")],
    [encode(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)],
    [encode(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)],
    ...images.map(image => [encode(`<< /Type /XObject /Subtype /Image /Width 900 /Height 500 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`), image, encode("\nendstream")]),
  ];
  const parts = [encode("%PDF-1.7\n")]; const offsets = [0]; let length = parts[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(length); const objectParts = [encode(`${index + 1} 0 obj\n`), ...objects[index], encode("\nendobj\n")];
    parts.push(...objectParts); length += objectParts.reduce((total, part) => total + part.length, 0);
  }
  const xrefOffset = length;
  parts.push(encode(`xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`));
  const pdf = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let position = 0;
  for (const part of parts) { pdf.set(part, position); position += part.length; }
  return Array.from(pdf);
}
