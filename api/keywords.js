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

const THRESHOLD = 3;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanText(text) {
  const lowerText = text.toLowerCase();
  const matched = [];

  for (const keyword of KEYWORDS) {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, 'i');
    if (pattern.test(lowerText)) {
      matched.push(keyword);
    }
  }

  return {
    matchCount: matched.length,
    qualified: matched.length >= THRESHOLD
  };
}

module.exports = { scanText, THRESHOLD };