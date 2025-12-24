// backend/src/scripts/seedUsuarios.js
// Ejecutar (desde la carpeta backend): node src/scripts/seedUsuarios.js

import dotenv from 'dotenv';
dotenv.config();

import sequelize from '../models/sequelize.js';

// Cargar modelos (misma estrategia que app.js)
import '../models/Role.js';
import '../models/Usuario.js';

const bcryptHash = async (plain) => {
    try {
        const mod = await import('bcryptjs');
        const bcrypt = mod.default || mod;
        return bcrypt.hash(plain, 10);
    } catch {
        const mod = await import('bcrypt');
        const bcrypt = mod.default || mod;
        return bcrypt.hash(plain, 10);
    }
};

const getModel = (names) => {
    for (const n of names) {
        if (sequelize.models?.[n]) return sequelize.models[n];
    }
    return null;
};

const RoleModel = getModel(['Role', 'Rol', 'Roles']);
const UsuarioModel = getModel(['Usuario', 'User', 'Users']);

const pickField = (model, candidates) => {
    const attrs = model?.rawAttributes || {};
    return candidates.find((c) => Object.prototype.hasOwnProperty.call(attrs, c)) || null;
};

const ensureRoles = async () => {
    if (!RoleModel) {
        console.warn('⚠️ No encontré modelo Role/Rol. Saltando creación de roles.');
        return;
    }

    const idField = pickField(RoleModel, ['id', 'rol_id']);
    const nombreRolField = pickField(RoleModel, ['nombre_rol', 'nombre', 'name', 'descripcion', 'label']);

    if (!nombreRolField) {
        console.warn('⚠️ No encontré el campo nombre_rol (o similar) en Role. No puedo crear roles.');
        return;
    }

    const roles = [
        { id: 0, nombre_rol: 'super_admin' },
        { id: 1, nombre_rol: 'admin' },
        { id: 2, nombre_rol: 'cobrador' }
    ];

    for (const r of roles) {
        try {
            // Si hay PK id, tratamos de mantener 0/1/2
            if (idField) {
                const where = { [idField]: r.id };
                const defaults = { [nombreRolField]: r.nombre_rol };

                const [row, created] = await RoleModel.findOrCreate({ where, defaults });

                // si existía, aseguro nombre_rol correcto
                if (!created && row?.[nombreRolField] !== r.nombre_rol) {
                    await row.update({ [nombreRolField]: r.nombre_rol });
                }
            } else {
                // si no hay id, creamos/aseguramos por nombre_rol
                const where = { [nombreRolField]: r.nombre_rol };
                await RoleModel.findOrCreate({ where, defaults: where });
            }

            console.log(`✅ Rol asegurado: ${r.nombre_rol}`);
        } catch (e) {
            console.warn(`⚠️ No pude asegurar rol ${r.nombre_rol} (${r.id}). Motivo:`, e?.message || e);
        }
    }
};

const buildUserPayload = async ({ rolId, nombreCompleto, username, passwordPlain }) => {
    const nombreCompletoField = pickField(UsuarioModel, ['nombre_completo', 'nombreCompleto', 'nombre']);
    const nombreUsuarioField = pickField(UsuarioModel, ['nombre_usuario', 'usuario', 'username', 'user', 'login']);
    const passField = pickField(UsuarioModel, ['password', 'clave', 'contrasena', 'contraseña', 'password_hash', 'hash_password']);
    const rolField = pickField(UsuarioModel, ['rol_id', 'role_id', 'rol', 'roleId', 'rolId']);

    if (!nombreCompletoField || !nombreUsuarioField || !passField) {
        const required = Object.entries(UsuarioModel?.rawAttributes || {})
            .filter(([, v]) => v?.allowNull === false && v?.defaultValue === undefined && v?.autoIncrement !== true)
            .map(([k]) => k);

        throw new Error(
            `Modelo Usuario no tiene los campos esperados. ` +
            `Detecté: nombre_completo=${nombreCompletoField}, nombre_usuario=${nombreUsuarioField}, password=${passField}. ` +
            `Requeridos: ${required.join(', ')}`
        );
    }

    const payload = {
        [nombreCompletoField]: nombreCompleto,
        [nombreUsuarioField]: username,
        [passField]: await bcryptHash(passwordPlain),
    };

    if (rolField) {
        payload[rolField] = rolId;
    }

    return { payload, nombreUsuarioField, passField };
};

const findExistingUser = async ({ username }) => {
    const nombreUsuarioField = pickField(UsuarioModel, ['nombre_usuario', 'usuario', 'username', 'user', 'login']);
    if (!nombreUsuarioField) return null;
    return UsuarioModel.findOne({ where: { [nombreUsuarioField]: username } });
};

const run = async () => {
    console.log('🔧 Seed usuarios: iniciando...');
    await sequelize.authenticate();

    await ensureRoles();

    if (!UsuarioModel) {
        console.error('❌ No encontré el modelo Usuario en sequelize.models. Revisá models/Usuario.js');
        process.exit(1);
    }

    const usersToCreate = [
        {
            rolId: 0,
            nombreCompleto: 'Super Admin',
            username: 'superadmin',
            passwordPlain: 'SuperAdmin123!',
        },
        {
            rolId: 1,
            nombreCompleto: 'Admin',
            username: 'admin',
            passwordPlain: 'Admin123!',
        },
        {
            rolId: 2,
            nombreCompleto: 'Cobrador',
            username: 'cobrador',
            passwordPlain: 'Cobrador123!',
        },
    ];

    for (const u of usersToCreate) {
        try {
            const existing = await findExistingUser(u);
            const { payload, passField } = await buildUserPayload(u);

            if (!existing) {
                await UsuarioModel.create(payload);
                console.log(`✅ Creado: ${u.username} (rol ${u.rolId})`);
            } else {
                // Actualizo password para asegurar acceso
                await existing.update({ [passField]: payload[passField] });
                console.log(`♻️ Ya existía: ${u.username}. Password actualizado.`);
            }
        } catch (e) {
            console.error(`❌ Error creando/actualizando ${u.username}:`, e?.message || e);

            const required = Object.entries(UsuarioModel.rawAttributes || {})
                .filter(([, v]) => v?.allowNull === false && v?.defaultValue === undefined && v?.autoIncrement !== true)
                .map(([k]) => k);

            if (required.length) {
                console.error('📌 Campos requeridos detectados en Usuario (allowNull:false):', required.join(', '));
            }
        }
    }

    console.log('✅ Seed finalizado.');
    await sequelize.close();
};

run().catch(async (e) => {
    console.error('❌ Seed falló:', e?.message || e);
    try { await sequelize.close(); } catch { }
    process.exit(1);
});
