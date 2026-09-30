const formidable = require("formidable");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { scanText } = require("./keywords");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const form = formidable({
    maxFileSize: 10 * 1024 * 1024, // 10MB
    multiples: false,
  });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(400).json({
        error: "Upload failed. Please check the file and try again.",
      });
    }

    const uploadedFile = Array.isArray(files.cv)
      ? files.cv[0]
      : files.cv;

    if (!uploadedFile) {
      return res.status(400).json({
        error: "Please upload your CV before continuing.",
      });
    }

    const filePath = uploadedFile.filepath;
    const fileName = uploadedFile.originalFilename || "";
    const extension = fileName.split(".").pop().toLowerCase();

    if (!["pdf", "docx"].includes(extension)) {
      return res.status(400).json({
        error:
          "Unsupported file type. Please upload a PDF or Word (.docx) file.",
      });
    }

    let extractedText = "";

    try {
      if (extension === "pdf") {
        const buffer = fs.readFileSync(filePath);
        const data = await pdfParse(buffer);
        extractedText = data.text;
      }

      if (extension === "docx") {
        const buffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value;
      }
    } catch (parseError) {
      console.error("CV parsing error:", parseError);

      return res.status(400).json({
        error:
          "We could not read this CV. Please upload another PDF or Word document.",
      });
    } finally {
      // Remove the temporary uploaded file after processing.
      try {
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (cleanupError) {
        console.error("CV cleanup error:", cleanupError);
      }
    }

    if (!extractedText || extractedText.trim().length < 20) {
      return res.status(400).json({
        error:
          "We could not find readable text in this CV. Please upload a different file.",
      });
    }

    const result = scanText(extractedText);

    // Deliberately return only the qualification decision.
    // Do NOT expose the keyword list, threshold, or match count.
    return res.status(200).json({
      qualified: result.qualified,
    });
  });
};

// Required for formidable on Vercel/serverless functions.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};