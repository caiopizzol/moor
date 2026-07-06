export function validateGithubUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (parsed.protocol !== "https:" || (host !== "github.com" && host !== "www.github.com")) {
      return "Only GitHub URLs are supported";
    }
  } catch {
    return "Invalid GitHub URL";
  }
  return null;
}
