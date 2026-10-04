const { formidable } = require("formidable");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { scanText } = require("./keywords");


module.exports = async function handler(req, res) {

  try {

    if (req.method !== "POST") {

      return res.status(405).json({
        error: "Method not allowed"
      });

    }


    const form = formidable({
      maxFileSize: 10 * 1024 * 1024,
      multiples: false
    });


    const { files } =
      await new Promise((resolve, reject) => {

        form.parse(
          req,
          (err, fields, files) => {

            if (err) {
              reject(err);
            } else {
              resolve({
                fields,
                files
              });
            }

          }
        );

      });


    const uploadedFile =
      Array.isArray(files.cv)
        ? files.cv[0]
        : files.cv;


    if (!uploadedFile) {

      return res.status(400).json({
        error:
          "Please upload your CV before continuing."
      });

    }


    const filePath =
      uploadedFile.filepath;

    const fileName =
      uploadedFile.originalFilename || "";


    const extension =
      fileName
        .split(".")
        .pop()
        .toLowerCase();


    if (!["pdf", "docx"].includes(extension)) {

      return res.status(400).json({
        error:
          "Unsupported file type. Please upload a PDF or Word (.docx) file."
      });

    }


    let extractedText = "";


    try {

      if (extension === "pdf") {

        const buffer =
          fs.readFileSync(filePath);

        const data =
          await pdfParse(buffer);

        extractedText =
          data.text;
      }


      if (extension === "docx") {

        const buffer =
          fs.readFileSync(filePath);

        const result =
          await mammoth.extractRawText({
            buffer
          });

        extractedText =
          result.value;
      }


    } catch (parseError) {

      console.error(
        "CV parsing error:",
        parseError
      );

      return res.status(400).json({
        error:
          "We could not read this CV. Please upload another PDF or Word document."
      });

    } finally {

      /*
        CV files are temporary only.
        They are deleted after processing.
      */

      try {

        if (
          filePath &&
          fs.existsSync(filePath)
        ) {

          fs.unlinkSync(filePath);

        }

      } catch (cleanupError) {

        console.error(
          "CV cleanup error:",
          cleanupError
        );

      }

    }


    if (
      !extractedText ||
      extractedText.trim().length < 20
    ) {

      return res.status(400).json({
        error:
          "We could not find readable text in this CV. Please upload a different file."
      });

    }


    const scanResult =
      scanText(extractedText);


    /*
      Only the qualification result leaves
      the server.

      The CV itself, extracted text,
      matched keywords and keyword list
      are never returned to the browser.
    */

    return res.status(200).json({
      qualified:
        scanResult.qualified
    });


  } catch (unexpectedError) {

    console.error(
      "Unexpected scan-cv error:",
      unexpectedError
    );


    return res.status(500).json({
      error:
        "Something went wrong while screening your CV. Please try again."
    });

  }

};


module.exports.config = {
  api: {
    bodyParser: false
  }
};