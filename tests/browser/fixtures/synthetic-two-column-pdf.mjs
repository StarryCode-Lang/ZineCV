// Entirely owned ASCII PDF, Type1 Helvetica and no ToUnicode table.
// The content stream deliberately alternates columns; visual coordinates,
// rather than content-stream ordering, determine the expected reading order.
export function syntheticTwoColumnPdf() {
  const left = ["Education", "Example University", "Bachelor 2020 to 2024", "LEFT COLUMN END"];
  const right = ["Skills", "Python", "JavaScript", "RIGHT COLUMN END"];
  const ops = ["BT /F1 20 Tf 60 740 Td (OWNED TWO COLUMN READING ORDER FIXTURE) Tj ET"];
  for (let index = 0; index < left.length; index++) {
    ops.push("BT /F1 12 Tf 60 "+(680-index*24)+" Td ("+left[index]+") Tj ET");
    ops.push("BT /F1 12 Tf 330 "+(680-index*24)+" Td ("+right[index]+") Tj ET");
  }
  const stream=ops.join("\n");
  const objects=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>","<< /Length "+Buffer.byteLength(stream)+" >>\nstream\n"+stream+"\nendstream"];
  const parts=["%PDF-1.7\n"], offsets=[0];let length=Buffer.byteLength(parts[0]);
  objects.forEach((body,index)=>{offsets.push(length);const object=(index+1)+" 0 obj\n"+body+"\nendobj\n";parts.push(object);length+=Buffer.byteLength(object);});
  parts.push("xref\n0 6\n0000000000 65535 f \n"+offsets.slice(1).map(offset=>String(offset).padStart(10,"0")+" 00000 n \n").join("")+"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"+length+"\n%%EOF");
  return Buffer.from(parts.join(""),"ascii");
}

