const KEYWORDS = [
  "network security",
  "firewall",
  "encryption",
  "malware",
  "phishing",
  "penetration testing",
  "ethical hacking",
  "vulnerability",
  "incident response",
  "SIEM",
  "SOC",
  "risk assessment",
  "cybersecurity",
  "information security",
  "TCP/IP",
  "Linux",
  "Python",
  "CompTIA Security+",
  "CISSP",
  "digital forensics"
];


// Minimum number of distinct keyword matches required
const THRESHOLD = 3;


// Escape characters that have special meaning in a RegExp
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// Check whether a keyword appears as a distinct word or phrase
function keywordMatches(text, keyword) {

  const escapedKeyword =
    escapeRegExp(keyword.toLowerCase());

  /*
    Allows punctuation inside keywords such as:
    TCP/IP
    CompTIA Security+

    while preventing a match inside a larger word.
  */
  const pattern = new RegExp(
    `(?<![a-z0-9])${escapedKeyword}(?![a-z0-9])`,
    "i"
  );

  return pattern.test(text);
}


// Scan the extracted CV text
function scanText(text) {

  const lowerText =
    text.toLowerCase();

  const matched = [];


  for (const keyword of KEYWORDS) {

    if (
      keywordMatches(
        lowerText,
        keyword
      )
    ) {

      matched.push(keyword);

    }

  }


  return {

    matchCount: matched.length,

    qualified:
      matched.length >= THRESHOLD

  };

}


module.exports = {
  scanText,
  THRESHOLD
};