import Role from '../models/Role.js';

export const obtenerRoles = async () => {
    return Role.findAll();
};
