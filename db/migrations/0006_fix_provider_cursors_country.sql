-- Ensure provider_cursors.country is non-null using empty string for global/default
UPDATE provider_cursors SET country = '' WHERE country IS NULL;
ALTER TABLE provider_cursors ALTER COLUMN country SET DEFAULT '';
ALTER TABLE provider_cursors ALTER COLUMN country SET NOT NULL;







