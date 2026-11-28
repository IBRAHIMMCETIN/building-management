/** Amplify'in `KeyValueStorageInterface`'i ile ayni sekil (aws-amplify/utils); mock adapter da kullanir. */
export interface KeyValueStorage {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}
