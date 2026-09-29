const formidable = require('formidable');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { scanText } = require('./keywords');

module.exports.config = {
  api: {
    bodyParser: false
  }
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const form = formidable({ maxFileSize: 5 * 1024 * 1024 });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(400).json({ error: 'Upload failed. Please try again.' });
    }

    const file = files.cv;
    if (!file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const filePath = Array.isArray(file) ? file[0].filepath : file.filepath;
    const fileName = Array.isArray(file) ? file[0].originalFilename : file.originalFilename;
    const extension = fileName.split('.').pop().toLowerCase();

    let extractedText = '';

    try {
      if (extension === 'pdf') {
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer);
        extractedText = data.text;
      } else if (extension === 'docx') {
        const buffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value;
      } else {
        return res.status(400).json({
          error: 'Unsupported file type. Please upload a PDF or Word (.docx) file.'
        });
      }
    } catch (parseError) {
      return res.status(400).json({
        error: 'We could not read this file. Please upload a different CV.'
      });
    }

    if (!extractedText || extractedText.trim().length < 20) {
      return res.status(400).json({
        error: 'We could not find readable text in this file. Please upload a different CV.'
      });
    }

    const result = scanText(extractedText);

    return res.status(200).json({
      qualified: result.qualified,
      matchCount: result.matchCount
    });
  });
};