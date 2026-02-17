export type DbCopilotSchemaSnapshot = {
  schema: string;
  tables: DbCopilotTable[];
  views?: DbCopilotView[];
  routines?: DbCopilotRoutine[];
  functions?: DbCopilotRoutine[];
  procedures?: DbCopilotRoutine[];
  capturedAt?: string | null;
};

export type DbCopilotTable = {
  name: string;
  columns: DbCopilotColumn[];
  primaryKey: string[];
  constraints?: DbCopilotConstraint[];
  foreignKeys: DbCopilotForeignKey[];
  indexes: DbCopilotIndex[];
  rowCount?: number;
};

export type DbCopilotColumn = {
  name: string;
  type: string;
  nullable: boolean;
  default?: string | null;
};

export type DbCopilotConstraint = {
  name: string;
  type: string;
  columns: string[];
  definition: string | null;
};

export type DbCopilotForeignKey = {
  name?: string;
  columns: string[];
  references: {
    schema: string;
    table: string;
    columns: string[];
  };
  onUpdate?: string | null;
  onDelete?: string | null;
};

export type DbCopilotIndex = {
  name: string;
  columns: string[];
  unique: boolean;
  method: string;
  primary?: boolean;
};

export type DbCopilotView = {
  name: string;
  definition: string | null;
};

export type DbCopilotRoutine = {
  name: string;
  kind: string | null;
  signature: string | null;
  returnType: string | null;
  language: string | null;
  definition?: string | null;
};

export type DbCopilotSchemaSnapshots = Record<string, DbCopilotSchemaSnapshot>;

export function createSampleDbCopilotSnapshots(): DbCopilotSchemaSnapshots {
  const publicSchema: DbCopilotSchemaSnapshot = {
    schema: "public",
    tables: [
      {
        name: "users",
        rowCount: 125400,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "email", type: "text", nullable: false },
          { name: "full_name", type: "text", nullable: false },
          { name: "created_at", type: "timestamptz", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [
          {
            name: "users_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
          {
            name: "users_email_key",
            columns: ["email"],
            unique: true,
            method: "btree",
          },
        ],
      },
      {
        name: "orders",
        rowCount: 742100,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "user_id", type: "uuid", nullable: false },
          { name: "promotion_id", type: "uuid", nullable: true },
          { name: "status", type: "text", nullable: false },
          { name: "total_cents", type: "int", nullable: false },
          { name: "created_at", type: "timestamptz", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [
          {
            columns: ["user_id"],
            references: {
              schema: "public",
              table: "users",
              columns: ["id"],
            },
          },
        ],
        indexes: [
          {
            name: "orders_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
          {
            name: "orders_user_id_idx",
            columns: ["user_id"],
            unique: false,
            method: "btree",
          },
          {
            name: "orders_status_created_idx",
            columns: ["status", "created_at"],
            unique: false,
            method: "btree",
          },
        ],
      },
      {
        name: "order_items",
        rowCount: 2318400,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "order_id", type: "uuid", nullable: false },
          { name: "product_id", type: "uuid", nullable: false },
          { name: "quantity", type: "int", nullable: false },
          { name: "price_cents", type: "int", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [
          {
            columns: ["order_id"],
            references: {
              schema: "public",
              table: "orders",
              columns: ["id"],
            },
          },
          {
            columns: ["product_id"],
            references: {
              schema: "public",
              table: "products",
              columns: ["id"],
            },
          },
        ],
        indexes: [
          {
            name: "order_items_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
          {
            name: "order_items_order_id_idx",
            columns: ["order_id"],
            unique: false,
            method: "btree",
          },
          {
            name: "order_items_product_id_idx",
            columns: ["product_id"],
            unique: false,
            method: "btree",
          },
        ],
      },
      {
        name: "products",
        rowCount: 12400,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "sku", type: "text", nullable: false },
          { name: "name", type: "text", nullable: false },
          { name: "category", type: "text", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [
          {
            name: "products_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
          {
            name: "products_sku_key",
            columns: ["sku"],
            unique: true,
            method: "btree",
          },
        ],
      },
      {
        name: "promotions",
        rowCount: 320,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "code", type: "text", nullable: false },
          { name: "active", type: "boolean", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [
          {
            name: "promotions_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
          {
            name: "promotions_code_key",
            columns: ["code"],
            unique: true,
            method: "btree",
          },
        ],
      },
    ],
  };

  const analyticsSchema: DbCopilotSchemaSnapshot = {
    schema: "analytics",
    tables: [
      {
        name: "accounts",
        rowCount: 4820,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "name", type: "text", nullable: false },
          { name: "plan", type: "text", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [
          {
            name: "accounts_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
        ],
      },
      {
        name: "sessions",
        rowCount: 520400,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "account_id", type: "uuid", nullable: false },
          { name: "started_at", type: "timestamptz", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [
          {
            columns: ["account_id"],
            references: {
              schema: "analytics",
              table: "accounts",
              columns: ["id"],
            },
          },
        ],
        indexes: [
          {
            name: "sessions_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
          {
            name: "sessions_account_id_idx",
            columns: ["account_id"],
            unique: false,
            method: "btree",
          },
        ],
      },
      {
        name: "events",
        rowCount: 8841200,
        columns: [
          { name: "id", type: "uuid", nullable: false },
          { name: "session_id", type: "uuid", nullable: false },
          { name: "account_id", type: "uuid", nullable: false },
          { name: "event_type", type: "text", nullable: false },
          { name: "captured_at", type: "timestamptz", nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [
          {
            columns: ["session_id"],
            references: {
              schema: "analytics",
              table: "sessions",
              columns: ["id"],
            },
          },
        ],
        indexes: [
          {
            name: "events_pkey",
            columns: ["id"],
            unique: true,
            primary: true,
            method: "btree",
          },
          {
            name: "events_session_id_idx",
            columns: ["session_id"],
            unique: false,
            method: "btree",
          },
          {
            name: "events_type_captured_idx",
            columns: ["event_type", "captured_at"],
            unique: false,
            method: "btree",
          },
        ],
      },
    ],
  };

  return {
    [publicSchema.schema]: publicSchema,
    [analyticsSchema.schema]: analyticsSchema,
  };
}
