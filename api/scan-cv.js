const { formidable } = require('formidable');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { scanText } = require('./keywords');
const { getPaymentPrice } = require('../lib/payment-prices');
const { createQualificationToken } = require('../lib/qualification-token');

function getFieldValue(field) {
  return Array.isArray(field) ? field[0] : field;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let uploadedFile;

  try {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024,
      maxTotalFileSize: 10 * 1024 * 1024,
      multiples: false
    });
    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (error, parsedFields, parsedFiles) => {
        if (error) {
          reject(error);
        } else {
          resolve({ fields: parsedFields, files: parsedFiles });
        }
      });
    });

    uploadedFile = Array.isArray(files.cv) ? files.cv[0] : files.cv;

    if (!uploadedFile) {
      return res.status(400).json({
        error: 'Please upload your CV before continuing.'
      });
    }

    const name = String(getFieldValue(fields.fullName) || '').trim();
    const email = String(getFieldValue(fields.email) || '').trim();
    const phone = String(getFieldValue(fields.phone) || '').trim();
    const track = String(getFieldValue(fields.track) || '').trim();

    if (
      !name ||
      name.length > 120 ||
      email.length > 254 ||
      phone.length > 30 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !getPaymentPrice(track, track === 'digital_forensics' ? 'GHS' : 'USD_REFERENCE')
    ) {
      return res.status(400).json({
        error: 'A valid name, email, and internship track are required.'
      });
    }

    const fileName = uploadedFile.originalFilename || '';
    const extension = fileName.split('.').pop().toLowerCase();

    if (!['pdf', 'docx'].includes(extension)) {
      return res.status(400).json({
        error: 'Unsupported file type. Please upload a PDF or Word (.docx) file.'
      });
    }

    let extractedText;

    try {
      const buffer = fs.readFileSync(uploadedFile.filepath);

      if (extension === 'pdf') {
        const parsedPdf = await pdfParse(buffer);
        extractedText = parsedPdf.text;
      } else {
        const parsedDocument = await mammoth.extractRawText({ buffer });
        extractedText = parsedDocument.value;
      }
    } catch (error) {
      console.error('CV parsing error:', error);
      return res.status(400).json({
        error: 'We could not read this CV. Please upload another PDF or Word document.'
      });
    }

    if (!extractedText || extractedText.trim().length < 20) {
      return res.status(400).json({
        error: 'We could not find readable text in this CV. Please upload a different file.'
      });
    }

    const scanResult = scanText(extractedText);

    if (!scanResult.qualified) {
      return res.status(200).json({ qualified: false });
    }

    let qualificationToken;

    try {
      qualificationToken = createQualificationToken({
        name,
        email,
        phone,
        track
      });
    } catch (error) {
      console.error('Qualification token configuration error:', error);
      return res.status(503).json({
        error: 'CV screening is temporarily unavailable because secure payment configuration is missing. Please contact the site administrator.'
      });
    }

    return res.status(200).json({
      qualified: true,
      qualificationToken
    });
  } catch (error) {
    console.error('Unexpected scan-cv error:', error);

    if (
      error.code === 1009 ||
      /maxFileSize|larger than/i.test(error.message || '')
    ) {
      return res.status(400).json({
        error: 'Your CV is too large. Please upload a file no larger than 10MB.'
      });
    }

    return res.status(500).json({
      error: 'Something went wrong while screening your CV. Please try again.'
    });
  } finally {
    if (uploadedFile && uploadedFile.filepath) {
      try {
        if (fs.existsSync(uploadedFile.filepath)) {
          fs.unlinkSync(uploadedFile.filepath);
        }
      } catch (error) {
        console.error('CV cleanup error:', error);
      }
    }
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
