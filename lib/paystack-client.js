const https = require('https');

function requestPaystack(method, path, data, failureMessage, timeoutMessage) {
  const payload = data === undefined ? null : JSON.stringify(data);

  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
    };

    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = https.request(
      {
        hostname: 'api.paystack.co',
        path,
        method,
        headers
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (response.statusCode >= 400 || !result.status) {
              const error = new Error(result.message || failureMessage);
              error.providerOutcome = 'rejected';
              return reject(error);
            }
            if (!result.data) {
              return reject(new Error(failureMessage));
            }
            resolve(result);
          } catch {
            reject(new Error('Invalid response received from Paystack.'));
          }
        });
      }
    );

    request.on('error', reject);
    request.setTimeout(15000, () => {
      request.destroy(new Error(timeoutMessage));
    });
    if (payload !== null) {
      request.write(payload);
    }
    request.end();
  });
}

function initializePaystackTransaction(data) {
  return requestPaystack(
    'POST',
    '/transaction/initialize',
    data,
    'Paystack could not initialize this payment.',
    'Paystack payment initialization timed out.'
  );
}

function verifyPaystackTransaction(reference) {
  return requestPaystack(
    'GET',
    `/transaction/verify/${encodeURIComponent(reference)}`,
    undefined,
    'Paystack verification failed.',
    'Paystack verification timed out.'
  );
}

module.exports = {
  initializePaystackTransaction,
  verifyPaystackTransaction
};
