-- Multi-tag support for entry routes
CREATE TABLE entry_route_tags (
  entry_route_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_route_id, tag_id)
);

CREATE INDEX idx_entry_route_tags_route ON entry_route_tags(entry_route_id);
CREATE INDEX idx_entry_route_tags_tag ON entry_route_tags(tag_id);
