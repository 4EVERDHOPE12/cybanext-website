const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'images', 'CYBANEXT NB (3).png');
const BRAND_COLOR = '#d20334';
const BODY_COLOR = '#252122';
const MUTED_COLOR = '#686365';
const PAGE_WIDTH = 491;
const FOOTER_TOP = 778;

function generatePaymentReceiptPdf(receipt) {
  if (!fs.existsSync(LOGO_PATH)) {
    throw new Error('Cybanext receipt branding asset is unavailable.');
  }

  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4',
      margins: { top: 48, right: 52, bottom: 34, left: 52 },
      info: {
        Title: `Cybanext payment receipt ${receipt.receiptNumber}`,
        Author: 'Cybanext',
        Subject: 'Verified Digital Forensics payment receipt',
        CreationDate: new Date(receipt.verifiedAt)
      }
    });
    const chunks = [];

    document.on('data', (chunk) => chunks.push(chunk));
    document.once('error', reject);
    document.once('end', () => resolve(Buffer.concat(chunks)));

    document.image(LOGO_PATH, 52, 38, { fit: [190, 54] });
    document
      .fontSize(10)
      .fillColor(BRAND_COLOR)
      .text('PAYMENT RECEIPT', 333, 54, { width: 210, align: 'right', characterSpacing: 1.2 });
    document
      .moveTo(52, 118)
      .lineTo(543, 118)
      .lineWidth(1)
      .strokeColor('#e8e4e3')
      .stroke();

    document
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(BODY_COLOR)
      .text('PAYMENT SUCCESSFUL', 52, 140);
    document
      .fontSize(10)
      .fillColor(MUTED_COLOR)
      .text('This receipt confirms a payment verified by Paystack.', 52, 170);

    document
      .roundedRect(52, 202, PAGE_WIDTH, 78, 4)
      .fill('#fff0f3');
    document
      .fontSize(9)
      .fillColor(MUTED_COLOR)
      .text('AMOUNT PAID', 70, 220);
    document
      .fontSize(25)
      .fillColor(BRAND_COLOR)
      .text(`${receipt.currency} ${Number(receipt.amount).toFixed(2)}`, 70, 240);
    document
      .fontSize(10)
      .fillColor(MUTED_COLOR)
      .text('PAYMENT STATUS: VERIFIED', 333, 245, { width: 190, align: 'right' });

    const rows = [
      ['Receipt number', receipt.receiptNumber],
      ['Applicant', receipt.applicantName],
      ['Programme', 'Digital Forensics'],
      ['Verified on', new Date(receipt.verifiedAt).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
      })],
      ['Payment reference', receipt.paymentReference],
      ['Paystack transaction ID', String(receipt.verifiedTransactionId)]
    ];
    const detailsStart = 302;
    const textSizes = [10, 9, 8, 7];
    let detailFontSize = null;
    for (const size of textSizes) {
      const requiredHeight = rows.reduce((height, [label, value]) => {
        document.font('Helvetica-Bold').fontSize(8);
        const labelHeight = document.heightOfString(label, { width: PAGE_WIDTH });
        document.font('Helvetica').fontSize(size);
        const valueHeight = document.heightOfString(String(value), {
          width: PAGE_WIDTH,
          lineGap: 2
        });
        return height + labelHeight + valueHeight + 16;
      }, 0);
      if (detailsStart + requiredHeight <= FOOTER_TOP - 12) {
        detailFontSize = size;
        break;
      }
    }
    if (detailFontSize === null) {
      reject(new Error('Receipt details cannot fit on one A4 page.'));
      return;
    }

    let y = detailsStart;
    for (const [label, value] of rows) {
      document.font('Helvetica-Bold').fontSize(8).fillColor(MUTED_COLOR);
      const labelHeight = document.heightOfString(label, { width: PAGE_WIDTH });
      document.text(label, 52, y, { width: PAGE_WIDTH });
      y += labelHeight + 2;

      const valueText = String(value);
      document.font('Helvetica').fontSize(detailFontSize).fillColor(BODY_COLOR);
      const valueHeight = document.heightOfString(valueText, {
        width: PAGE_WIDTH,
        lineGap: 2
      });
      document.text(valueText, 52, y, {
        width: PAGE_WIDTH,
        lineGap: 2,
        lineBreak: true
      });
      y += valueHeight + 7;

      document
        .moveTo(52, y)
        .lineTo(543, y)
        .lineWidth(0.5)
        .strokeColor('#e8e4e3')
        .stroke();
      y += 7;
    }

    document
      .moveTo(52, FOOTER_TOP - 1)
      .lineTo(543, FOOTER_TOP - 1)
      .lineWidth(0.75)
      .strokeColor('#e8e4e3')
      .stroke();
    document
      .fontSize(9)
      .fillColor(MUTED_COLOR)
      .text('support@cybanext.com', 52, FOOTER_TOP + 10, {
        width: PAGE_WIDTH,
        align: 'center'
      });
    document.end();
  });
}

module.exports = { generatePaymentReceiptPdf };
