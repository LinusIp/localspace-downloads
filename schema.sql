-- The only table. One row per day (UTC) and file; nothing about the visitor.
CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL,
  file TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, file)
);
