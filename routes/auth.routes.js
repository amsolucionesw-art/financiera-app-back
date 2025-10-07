import { Router } from 'express';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { loginUsuario } from '../services/usuario.service.js';

dotenv.config(); // Asegura que JWT_SECRET esté disponible

const router = Router();

// POST /auth/login
router.post('/login', async (req, res) => {
  const { nombre_usuario, password } = req.body;

  if (!nombre_usuario || !password) {
    return res.status(400).json({ success: false, message: 'Faltan credenciales' });
  }

  try {
    const usuario = await loginUsuario(nombre_usuario, password);

    if (!usuario) {
      return res.status(401).json({ success: false, message: 'Usuario o contraseña inválidos' });
    }

    const token = jwt.sign(
      {
        id: usuario.id,
        rol_id: usuario.rol_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre_completo }
    });
  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});

export default router;
