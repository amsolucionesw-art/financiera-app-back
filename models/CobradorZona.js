import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';
import Usuario from './Usuario.js';
import Zona from './Zona.js';

const CobradorZona = sequelize.define('CobradorZona', {
    cobrador_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: Usuario, key: 'id' }
    },
    zona_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: Zona, key: 'id' }
    }
}, {
    tableName: 'cobrador_zona',
    timestamps: false
});

Usuario.belongsToMany(Zona, { through: CobradorZona, foreignKey: 'cobrador_id', as: 'zonas' });
Zona.belongsToMany(Usuario, { through: CobradorZona, foreignKey: 'zona_id', as: 'cobradores' });

export default CobradorZona;