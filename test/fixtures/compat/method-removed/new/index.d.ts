export interface Client {
  request(): void;
}
export declare function createClient(): Client;
