const crypto = require('node:crypto');
const { del, get, put } = require('@vercel/blob');

const RECEIPT_BLOB_PATH_PATTERN =
  /^applicant-payment-receipts\/[A-Za-z0-9_-]{1,80}\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.pdf$/;

async function readStream(stream) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new Error('Private receipt content is unavailable.');
  }

  const reader = stream.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error('Private receipt content is invalid.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function createPrivateReceiptStorage({
  deleteBlob = del,
  putBlob = put,
  getBlob = get
} = {}) {
  async function putPrivateReceipt(pathname, body) {
    await putBlob(pathname, body, {
      access: 'private',
      addRandomSuffix: false,
      cacheControlMaxAge: 60,
      contentType: 'application/pdf'
    });
    return pathname;
  }

  async function deletePrivateReceipt(pathname) {
    if (typeof pathname !== 'string' || !RECEIPT_BLOB_PATH_PATTERN.test(pathname)) {
      throw new TypeError('A unique receipt Blob pathname is required.');
    }

    await deleteBlob(pathname);
  }

  async function getPrivateReceipt(pathname) {
    if (
      typeof pathname !== 'string' ||
      !pathname.startsWith('applicant-payment-receipts/') ||
      pathname.split('/').includes('..')
    ) {
      throw new TypeError('A valid private receipt pathname is required.');
    }

    const result = await getBlob(pathname, {
      access: 'private',
      useCache: false
    });
    if (
      !result ||
      result.statusCode !== 200 ||
      !result.stream ||
      !result.blob ||
      result.blob.pathname !== pathname
    ) {
      throw new Error('Private receipt content is unavailable.');
    }

    const pdf = await readStream(result.stream);
    if (pdf.length === 0 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('Private receipt content is not a valid PDF.');
    }
    return pdf;
  }

  async function getVerifiedReceiptPdf(receipt) {
    if (
      !receipt ||
      receipt.generationStatus !== 'ready' ||
      typeof receipt.pdfSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt.pdfSha256)
    ) {
      throw new Error('Stored receipt integrity metadata is invalid.');
    }

    const pdf = await getPrivateReceipt(receipt.blobPathname);
    const actualChecksum = crypto.createHash('sha256').update(pdf).digest('hex');
    const expectedBytes = Buffer.from(receipt.pdfSha256, 'hex');
    const actualBytes = Buffer.from(actualChecksum, 'hex');
    if (!crypto.timingSafeEqual(expectedBytes, actualBytes)) {
      throw new Error('Stored receipt checksum does not match.');
    }
    return pdf;
  }

  return {
    deletePrivateReceipt,
    getPrivateReceipt,
    getVerifiedReceiptPdf,
    putPrivateReceipt
  };
}

const privateReceiptStorage = createPrivateReceiptStorage();

module.exports = {
  ...privateReceiptStorage,
  createPrivateReceiptStorage
};
