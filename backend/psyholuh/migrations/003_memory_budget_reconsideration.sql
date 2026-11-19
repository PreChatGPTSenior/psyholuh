ALTER TABLE jobs ADD COLUMN budget_required_nano INTEGER CHECK (budget_required_nano > 0);
