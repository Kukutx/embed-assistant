-- 1.0.15: website sources (follow links from a start page).
ALTER TABLE knowledge_sources DROP CONSTRAINT IF EXISTS knowledge_sources_type_check;
ALTER TABLE knowledge_sources ADD CONSTRAINT knowledge_sources_type_check CHECK (type IN ('url', 'sitemap', 'website', 'manual'));
