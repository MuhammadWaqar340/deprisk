export interface Client {
  request(): void;
  cancel(): void;
}
export declare function createClient(): Client;
