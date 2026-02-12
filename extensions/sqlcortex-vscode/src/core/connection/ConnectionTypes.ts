export type ConnectionSslMode = "disable" | "prefer" | "require";

export type ConnectionProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: ConnectionSslMode;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionState = {
  status: "connected" | "disconnected";
  profile: ConnectionProfile | null;
};
