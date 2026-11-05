-- Keep the verification digests and model state for the account claim flow.
UPDATE applications SET pass_note = NULL WHERE pass_note IS NOT NULL;
