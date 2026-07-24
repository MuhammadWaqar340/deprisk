import { createClient } from "compat-pkg";
export function createApiClient() {
  return createClient("https://api.example.com");
}
