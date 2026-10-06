export function readAutomationIdentity(prompt) {
  return JSON.parse(prompt.match(/Data app identity: ([^\n]+)/u)?.[1]);
}

export function readAutomationQueries(prompt) {
  return JSON.parse(prompt.match(/Reviewed query IDs: ([^\n]+)/u)?.[1] ?? "[]");
}
