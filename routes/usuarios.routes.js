import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import Cliente from '../models/Cliente.js';

import {
    obtenerUsuarios,
    obtenerUsuarioPorId,
    crearUsuario,
    actualizarUsuario,
    eliminarUsuario,
    cambiarPassword,
    obtenerCobradoresConZonas,
    obtenerCobradoresBasico
} from '../services/usuario.service.js';

const router = Router();

// Perfil propio
router.get('/me', verifyToken, async (req, res) => {
    try {
        const uid = req?.user?.id;
        if (!uid) {
            return res.status(401).json({
                success: false,
                message: 'Token inválido: no se pudo determinar el usuario'
            });
        }

        const usuario = await obtenerUsuarioPorId(uid);
        if (!usuario) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }
        res.json({ success: true, data: usuario });
    } catch (error) {
        console.error('[USUARIOS][GET /me]', error);
        res.status(500).json({ success: false, message: 'Error obteniendo tu perfil' });
    }
});

// GET - todos los usuarios
router.get('/', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const usuarios = await obtenerUsuarios();
        res.json({ success: true, data: usuarios });
    } catch (error) {
        console.error('[USUARIOS][GET /]', error);
        res.status(500).json({ success: false, message: 'Error obteniendo usuarios' });
    }
});

/* ──────────────────────────────────────────────────────────
   COBRADORES (ORDENADO ANTES DE '/:id' PARA EVITAR COLISIONES)
   ────────────────────────────────────────────────────────── */

// GET - cobradores básico (id, nombre_completo)
router.get('/cobradores', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const cobradores = await obtenerCobradoresBasico();
        res.json({ success: true, data: cobradores });
    } catch (error) {
        console.error('[USUARIOS][GET /cobradores]', error);
        res.status(500).json({ success: false, message: 'Error obteniendo cobradores' });
    }
});

// GET - cobradores con sus zonas asignadas
router.get('/cobradores/zonas', verifyToken, checkRole([0, 1]), async (req, res) => {
    try {
        const cobradores = await obtenerCobradoresConZonas();
        res.json({ success: true, data: cobradores });
    } catch (error) {
        console.error('[USUARIOS][GET /cobradores/zonas]', error);
        res.status(500).json({ success: false, message: 'Error obteniendo cobradores con zonas' });
    }
});

// GET - usuario por ID
router.get('/:id', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const usuario = await obtenerUsuarioPorId(req.params.id);
        if (!usuario) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }
        res.json({ success: true, data: usuario });
    } catch (error) {
        console.error('[USUARIOS][GET /:id]', error);
        res.status(500).json({ success: false, message: 'Error obteniendo usuario' });
    }
});

// POST - crear usuario
router.post('/', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const id = await crearUsuario(req.body);
        res.status(201).json({ success: true, message: 'Usuario creado exitosamente', data: { id } });
    } catch (error) {
        console.error('[USUARIOS][POST /]', error);
        res.status(500).json({ success: false, message: 'Error creando usuario' });
    }
});

// PUT - actualizar usuario
router.put('/:id', verifyToken, checkRole([0]), async (req, res) => {
    try {
        await actualizarUsuario(req.params.id, req.body);
        res.json({ success: true, message: 'Usuario actualizado exitosamente' });
    } catch (error) {
        console.error('[USUARIOS][PUT /:id]', error);
        res.status(500).json({ success: false, message: 'Error actualizando usuario' });
    }
});

// DELETE - eliminar usuario
router.delete('/:id', verifyToken, checkRole([0]), async (req, res) => {
    const { id } = req.params;

    try {
        const usuario = await obtenerUsuarioPorId(id);
        if (!usuario) {
            return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
        }

        const rolId = usuario.rol?.id;
        if (rolId === 2) {
            // Uso correcto de la columna 'cobrador'
            const clienteAsignado = await Cliente.findOne({ where: { cobrador: id } });
            if (clienteAsignado) {
                return res.status(400).json({
                    success: false,
                    message: 'No se puede eliminar un cobrador con clientes asignados'
                });
            }
        }

        await eliminarUsuario(id);
        res.json({ success: true, message: 'Usuario eliminado exitosamente' });
    } catch (error) {
        console.error('[USUARIOS][DELETE /:id]', error);
        res.status(500).json({
            success: false,
            message: 'Error eliminando usuario'
        });
    }
});

// PUT - cambiar contraseña de usuario
router.put('/:id/password', verifyToken, checkRole([0]), async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ success: false, message: 'La nueva contraseña es obligatoria' });
        }
        await cambiarPassword(req.params.id, password);
        res.json({ success: true, message: 'Contraseña actualizada exitosamente' });
    } catch (error) {
        console.error('[USUARIOS][PUT /:id/password]', error);
        res.status(500).json({ success: false, message: 'Error al cambiar contraseña' });
    }
});

export default router;

