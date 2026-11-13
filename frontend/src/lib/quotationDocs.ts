// Builds the quotation PDF and Excel files in the browser, from the same data,
// so both match the sample layout. Nothing is sent to a paid service.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import ExcelJS from 'exceljs';

export type LoadedImage = { bytes: Uint8Array; width: number; height: number };

export type DocItem = {
  description: string;
  unitPrice: number;
  qty: number;
  image: LoadedImage | null;
};

export type QuoteDoc = {
  businessName: string;
  website: string;
  footerText: string;
  quoteNumber: number;
  quoteDate: string;
  validUntil: string;
  customerRef: string;
  companyName: string;
  billToName: string;
  addressLines: string;
  city: string;
  country: string;
  phone: string;
  preparedBy: string;
  preparedByPhone: string;
  currency: string;
  terms: string;
  items: DocItem[];
};

// File name rule: company name (or bill-to name when blank) + quote number.
export function quoteFileName(doc: { companyName: string; billToName: string; quoteNumber: number }, extension: 'pdf' | 'xlsx') {
  const base = (doc.companyName.trim() || doc.billToName.trim() || 'Customer')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base}-${doc.quoteNumber}.${extension}`;
}

export function formatAmount(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Shrinks a photo to at most 800px on its long side and encodes it as JPEG (80%).
export async function toLoadedImage(blob: Blob): Promise<LoadedImage> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the photo.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const jpeg = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo.'))), 'image/jpeg', 0.8),
  );
  return { bytes: new Uint8Array(await jpeg.arrayBuffer()), width, height };
}

// ---------- PDF ----------

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const M = 42.52; // 15 mm
const CONTENT_W = PAGE_W - 2 * M;
const COL_PCT = [8, 17, 41, 11, 8, 15]; // Sr no | Image | Description | Price | Qty | AMOUNT
const COL_W = COL_PCT.map((p) => (CONTENT_W * p) / 100);
const ROW_H = 85;
const IMG_BOX_W = 54; // 19 x 27 mm, portrait 5:7
const IMG_BOX_H = 76;
const HEADER_H = 22;
const FOOTER_RESERVE = 90;

// The built-in PDF fonts only cover Western characters. Replace common
// punctuation with plain equivalents and anything else with "?".
function pdfText(text: string) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\n\r\t\x20-\x7E\xA0-\xFF]/g, '?');
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of pdfText(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function buildPdf(doc: QuoteDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.45, 0.45, 0.45);
  const lineColor = rgb(0.6, 0.6, 0.6);
  const headerFill = rgb(0.92, 0.92, 0.92);
  const imageCache = new Map<LoadedImage, PDFImage>();

  const pages: PDFPage[] = [];
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  const ty = (top: number) => PAGE_H - top; // convert a top-based y to PDF's bottom-based y
  const xs = [M];
  COL_W.forEach((w) => xs.push(xs[xs.length - 1] + w));

  const text = (value: string, x: number, topY: number, size: number, f: PDFFont, color = rgb(0, 0, 0)) =>
    page.drawText(pdfText(value), { x, y: ty(topY), size, font: f, color });

  // Header: business block (left) and quotation block (right).
  text(doc.businessName, M, M + 14, 16, bold);
  const title = 'Quotation';
  const titleSize = 26;
  page.drawText(title, {
    x: PAGE_W - M - bold.widthOfTextAtSize(title, titleSize),
    y: ty(M + 22),
    size: titleSize,
    font: bold,
    color: grey,
  });

  const rightLabelX = PAGE_W - M - 205;
  const rightValueX = PAGE_W - M - 115;
  const rightRows: [string, string][] = [
    ['DATE', doc.quoteDate],
    ['Quotation #', String(doc.quoteNumber)],
    ['Customer ID', doc.customerRef],
    ['Valid until', doc.validUntil],
    ['Prepared by', doc.preparedBy],
  ];
  let rightEnd = M + 52;
  rightRows.forEach(([label, value]) => {
    text(label, rightLabelX, rightEnd, 9, bold, grey);
    text(value, rightValueX, rightEnd, 9, font);
    rightEnd += 14;
  });
  if (doc.preparedByPhone) {
    text(`Phone : ${doc.preparedByPhone}`, rightValueX, rightEnd, 9, font);
    rightEnd += 14;
  }
  if (doc.website) {
    text(doc.website, PAGE_W - M - bold.widthOfTextAtSize(doc.website, 9), rightEnd + 4, 9, font);
    rightEnd += 18;
  }

  let leftEnd = M + 52;
  if (doc.companyName) {
    text(doc.companyName, M, leftEnd, 12, bold);
    leftEnd += 16;
  }
  for (const line of wrap(doc.addressLines, font, 10, 260)) {
    text(line, M, leftEnd, 10, font);
    leftEnd += 13;
  }
  leftEnd += 8;
  text('Bill To:', M, leftEnd, 10, bold);
  leftEnd += 14;
  text(doc.billToName, M, leftEnd, 10, font);
  leftEnd += 13;
  const cityCountry = [doc.city, doc.country].filter(Boolean).join(', ');
  if (cityCountry) {
    text(cityCountry, M, leftEnd, 10, font);
    leftEnd += 13;
  }
  if (doc.phone) {
    text(`Phone : ${doc.phone}`, M, leftEnd, 10, font);
    leftEnd += 13;
  }

  let top = Math.max(leftEnd, rightEnd) + 22;

  const drawTableHeader = () => {
    page.drawRectangle({ x: M, y: ty(top + HEADER_H), width: CONTENT_W, height: HEADER_H, color: headerFill, borderColor: lineColor, borderWidth: 0.6 });
    const labels = ['Sr no', 'Image', 'Description', 'Price', 'Qty', 'AMOUNT'];
    labels.forEach((label, i) => {
      const w = bold.widthOfTextAtSize(label, 10);
      page.drawText(label, { x: xs[i] + (COL_W[i] - w) / 2, y: ty(top + 15), size: 10, font: bold });
    });
    top += HEADER_H;
  };

  const newPage = () => {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    top = M;
  };

  drawTableHeader();

  for (let index = 0; index < doc.items.length; index++) {
    const item = doc.items[index];
    if (top + ROW_H > PAGE_H - M - FOOTER_RESERVE) {
      newPage();
      drawTableHeader();
    }
    const rowBottom = ty(top + ROW_H);
    page.drawRectangle({ x: M, y: rowBottom, width: CONTENT_W, height: ROW_H, borderColor: lineColor, borderWidth: 0.6 });
    xs.slice(1, -1).forEach((x) => page.drawLine({ start: { x, y: rowBottom }, end: { x, y: rowBottom + ROW_H }, thickness: 0.6, color: lineColor }));

    const centerTop = top + ROW_H / 2 + 4;
    const center = (value: string, col: number, size = 10, f = font) => {
      const w = f.widthOfTextAtSize(pdfText(value), size);
      page.drawText(pdfText(value), { x: xs[col] + (COL_W[col] - w) / 2, y: ty(centerTop), size, font: f });
    };
    center(String(index + 1), 0);

    if (item.image) {
      let embedded = imageCache.get(item.image);
      if (!embedded) {
        embedded = await pdf.embedJpg(item.image.bytes);
        imageCache.set(item.image, embedded);
      }
      // Keep the picture's proportions and centre it in the box.
      const scale = Math.min(IMG_BOX_W / embedded.width, IMG_BOX_H / embedded.height);
      const w = embedded.width * scale;
      const h = embedded.height * scale;
      page.drawImage(embedded, {
        x: xs[1] + (COL_W[1] - w) / 2,
        y: rowBottom + (ROW_H - h) / 2,
        width: w,
        height: h,
      });
    }

    const lines = wrap(item.description, font, 10, COL_W[2] - 12);
    const lineH = 13;
    let lineTop = top + (ROW_H - lines.length * lineH) / 2 + 9;
    for (const line of lines) {
      const w = font.widthOfTextAtSize(line, 10);
      page.drawText(line, { x: xs[2] + (COL_W[2] - w) / 2, y: ty(lineTop), size: 10, font });
      lineTop += lineH;
    }

    center(formatAmount(item.unitPrice), 3);
    center(String(item.qty), 4);
    const amount = formatAmount(item.unitPrice * item.qty);
    const amountW = font.widthOfTextAtSize(amount, 10);
    page.drawText(amount, { x: xs[5] + COL_W[5] - 6 - amountW, y: ty(centerTop), size: 10, font });

    top += ROW_H;
  }

  // Totals: quantity under Qty, boxed amount under AMOUNT, right aligned.
  const totalQty = doc.items.reduce((sum, i) => sum + i.qty, 0);
  const totalAmount = doc.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
  if (top + 40 > PAGE_H - M - FOOTER_RESERVE) newPage();
  const qtyText = String(totalQty);
  page.drawText(qtyText, {
    x: xs[4] + (COL_W[4] - bold.widthOfTextAtSize(qtyText, 10)) / 2,
    y: ty(top + 17),
    size: 10,
    font: bold,
  });
  const amountText = `${doc.currency} ${formatAmount(totalAmount)}`;
  // Box covers the AMOUNT column only, from 4pt to 26pt below the table.
  page.drawRectangle({
    x: xs[5],
    y: ty(top + 26),
    width: COL_W[5],
    height: 22,
    borderColor: rgb(0, 0, 0),
    borderWidth: 0.8,
  });
  // Smaller text for very large totals, so they still fit in the box.
  const amountSize = bold.widthOfTextAtSize(amountText, 10) > COL_W[5] - 8 ? 8 : 10;
  page.drawText(amountText, {
    x: xs[5] + COL_W[5] - 4 - bold.widthOfTextAtSize(amountText, amountSize),
    y: ty(top + 19),
    size: amountSize,
    font: bold,
  });
  top += 40;

  // Terms, as typed, numbered by the user.
  const termsSize = 9;
  const termLines = wrap(doc.terms, font, termsSize, CONTENT_W);
  const needed = termLines.length * 12 + 24;
  if (top + needed > PAGE_H - M - FOOTER_RESERVE) newPage();
  text('Terms and Conditions', M, top, 10, bold);
  top += 16;
  for (const line of termLines) {
    if (top > PAGE_H - M - FOOTER_RESERVE) {
      newPage();
      top = M;
    }
    text(line, M, top, termsSize, font);
    top += 12;
  }

  // Footer on every page: thank-you text, then "Page X of Y".
  const total = pages.length;
  pages.forEach((p, i) => {
    const footer = pdfText(doc.footerText);
    if (footer) {
      p.drawText(footer, { x: (PAGE_W - bold.widthOfTextAtSize(footer, 10)) / 2, y: 58, size: 10, font: bold });
    }
    const label = `Page ${i + 1} of ${total}`;
    p.drawText(label, { x: (PAGE_W - font.widthOfTextAtSize(label, 8)) / 2, y: 40, size: 8, font, color: grey });
  });

  return pdf.save();
}

// ---------- Excel ----------

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function buildXlsx(doc: QuoteDoc): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Quotation');
  ws.columns = [{ width: 5 }, { width: 12.6 }, { width: 34.5 }, { width: 8.9 }, { width: 11 }, { width: 18.6 }];
  ws.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };

  const thin = { style: 'thin' as const, color: { argb: 'FF999999' } };
  const boxBorder = { top: thin, left: thin, bottom: thin, right: thin };

  // Header
  ws.getCell('A1').value = doc.businessName;
  ws.getCell('A1').font = { bold: true, size: 16 };
  ws.getCell('F1').value = 'Quotation';
  ws.getCell('F1').font = { size: 22, color: { argb: 'FF737373' } };
  ws.getCell('F1').alignment = { horizontal: 'right' };

  const right: [string, string | number][] = [
    ['DATE', doc.quoteDate],
    ['Quotation #', doc.quoteNumber],
    ['Customer ID', doc.customerRef],
    ['Valid until', doc.validUntil],
    ['Prepared by', doc.preparedBy],
  ];
  if (doc.preparedByPhone) right.push(['Phone', doc.preparedByPhone]);
  right.forEach(([label, value], i) => {
    const r = 3 + i;
    ws.getCell(`E${r}`).value = label;
    ws.getCell(`E${r}`).font = { bold: true, color: { argb: 'FF737373' } };
    ws.getCell(`E${r}`).alignment = { horizontal: 'right' };
    ws.getCell(`F${r}`).value = value;
  });
  if (doc.website) {
    ws.getCell('F2').value = doc.website;
    ws.getCell('F2').alignment = { horizontal: 'right' };
  }

  let row = 3;
  const left = (value: string, bold = false) => {
    ws.getCell(`A${row}`).value = value;
    ws.getCell(`A${row}`).font = { bold };
    row++;
  };
  if (doc.companyName) left(doc.companyName, true);
  doc.addressLines.split('\n').filter(Boolean).forEach((line) => left(line));
  row++;
  left('Bill To:', true);
  left(doc.billToName);
  const cityCountry = [doc.city, doc.country].filter(Boolean).join(', ');
  if (cityCountry) left(cityCountry);
  if (doc.phone) left(`Phone : ${doc.phone}`);

  // Items table
  const headerRow = Math.max(row, 3 + right.length) + 2;
  ['Sr no', 'Image', 'Description', 'Price', 'Qty', 'AMOUNT'].forEach((label, i) => {
    const cell = ws.getRow(headerRow).getCell(i + 1);
    cell.value = label;
    cell.font = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEBEBEB' } };
    cell.border = boxBorder;
  });

  const firstItem = headerRow + 1;
  doc.items.forEach((item, index) => {
    const r = firstItem + index;
    const excelRow = ws.getRow(r);
    excelRow.height = 85.5;
    excelRow.getCell(1).value = index + 1;
    excelRow.getCell(3).value = item.description;
    excelRow.getCell(3).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
    excelRow.getCell(4).value = item.unitPrice;
    excelRow.getCell(4).numFmt = '#,##0.00';
    excelRow.getCell(5).value = item.qty;
    excelRow.getCell(6).value = { formula: `D${r}*E${r}`, result: item.unitPrice * item.qty };
    excelRow.getCell(6).numFmt = '#,##0.00';
    for (let c = 1; c <= 6; c++) {
      const cell = excelRow.getCell(c);
      cell.border = boxBorder;
      cell.alignment = { ...cell.alignment, vertical: 'middle', horizontal: c === 3 ? 'center' : c === 6 ? 'right' : 'center', wrapText: c === 3 };
    }
    if (item.image) {
      const imageId = wb.addImage({ base64: bytesToBase64(item.image.bytes), extension: 'jpeg' });
      // Fit inside a 19 x 27 mm box, keeping proportions (1pt = 4/3 px).
      const scale = Math.min((IMG_BOX_W * 4) / 3 / item.image.width, (IMG_BOX_H * 4) / 3 / item.image.height);
      ws.addImage(imageId, {
        tl: { col: 1.1, row: r - 1 + 0.08 },
        ext: { width: item.image.width * scale, height: item.image.height * scale },
      });
    }
  });

  const lastItem = firstItem + doc.items.length - 1;
  const totalRow = lastItem + 1;
  const totalQty = doc.items.reduce((sum, i) => sum + i.qty, 0);
  const totalAmount = doc.items.reduce((sum, i) => sum + i.unitPrice * i.qty, 0);
  ws.getCell(`E${totalRow}`).value = { formula: `SUM(E${firstItem}:E${lastItem})`, result: totalQty };
  ws.getCell(`E${totalRow}`).font = { bold: true };
  ws.getCell(`E${totalRow}`).alignment = { horizontal: 'center' };
  ws.getCell(`F${totalRow}`).value = { formula: `SUM(F${firstItem}:F${lastItem})`, result: totalAmount };
  ws.getCell(`F${totalRow}`).numFmt = `"${doc.currency} "#,##0.00`;
  ws.getCell(`F${totalRow}`).font = { bold: true };
  ws.getCell(`F${totalRow}`).alignment = { horizontal: 'right' };
  ws.getCell(`F${totalRow}`).border = { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } };

  // Terms and footer
  let termsRow = totalRow + 2;
  ws.getCell(`A${termsRow}`).value = 'Terms and Conditions';
  ws.getCell(`A${termsRow}`).font = { bold: true };
  termsRow++;
  for (const line of doc.terms.split('\n')) {
    ws.mergeCells(`A${termsRow}:F${termsRow}`);
    ws.getCell(`A${termsRow}`).value = line;
    ws.getCell(`A${termsRow}`).alignment = { wrapText: true };
    termsRow++;
  }
  if (doc.footerText) {
    termsRow++;
    ws.mergeCells(`A${termsRow}:F${termsRow}`);
    ws.getCell(`A${termsRow}`).value = doc.footerText;
    ws.getCell(`A${termsRow}`).font = { bold: true };
    ws.getCell(`A${termsRow}`).alignment = { horizontal: 'center' };
  }

  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
