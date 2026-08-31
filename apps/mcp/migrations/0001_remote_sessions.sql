CREATE TABLE fitia_sessions (
  clerk_user_id text PRIMARY KEY,
  fitia_account_id text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK (octet_length(iv) = 12),
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fitia_link_codes (
  code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
  clerk_user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX fitia_link_codes_user_idx ON fitia_link_codes (clerk_user_id);
CREATE INDEX fitia_link_codes_expiry_idx ON fitia_link_codes (expires_at);
