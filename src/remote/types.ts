export interface RemoteTarget {
  host: string;
  port: number;
}

export interface RemoteAuth {
  user: string;
  password: string;
}

/** Isang paunang-nakaconfigure na fleet ng mga deployment target na nagbabahagi ng iisang set ng credentials. */
export interface RemoteConfig {
  targets: RemoteTarget[];
  auth: RemoteAuth;
}

