-- Runs once, on first initialisation of an empty Postgres data volume.
-- Gives integration tests their own database so a test that truncates or drops
-- tables can never destroy development data.
CREATE DATABASE shortener_test;
