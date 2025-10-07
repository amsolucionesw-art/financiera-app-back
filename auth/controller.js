import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db.js'; // ajustá la ruta si tu archivo de conexión a la BD está en otro lado
import { SECRET_KEY } from '../config.js'; // donde tengas la clave secreta

export const login = async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE username = ?', [username]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const user = rows[0];

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      return res.status(401).json({ message: 'Contraseña incorrecta' });
    }

    const token = jwt.sign(
      { id: user.id, rol_id: user.rol_id },
      SECRET_KEY,
      { expiresIn: '8h' }
    );

    res.json({ token });
    
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ message: 'Error del servidor' });
  }
};
