ALTER TABLE status_labels DROP CONSTRAINT IF EXISTS status_labels_color_check;
ALTER TABLE status_labels ADD CONSTRAINT status_labels_color_check
  CHECK (color IN ('morado', 'azul', 'verde', 'amarillo', 'naranja', 'rojo', 'rosa', 'gris', 'turquesa'));
