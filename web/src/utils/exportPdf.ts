import { jsPDF } from "jspdf";

// Imported only when requested; PDF dependencies are absent from the startup path.
export function savePngPdf(png: string, filename: string): void {
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const props = pdf.getImageProperties(png);
  const ratio = Math.min(pageWidth / props.width, pageHeight / props.height);
  const width = props.width * ratio;
  const height = props.height * ratio;
  pdf.addImage(png, "PNG", (pageWidth - width) / 2, (pageHeight - height) / 2, width, height);
  pdf.save(filename);
}
