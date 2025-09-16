jest.mock('../utils/firebaseUtils', () => ({
    bucket: { name: 'my-bucket.appspot.com' },
    db: { collection: () => ({ doc: () => ({ set: async () => { } }) }) },
    INPUT_ROOT: 'user-uploads',
    OUTPUT_ROOT: 'user-outputs',
    PUBLIC_ROOT: 'public',
    buildOwnerInputPath: (uid, fn) => `user-uploads/${uid}/${fn}`,
    buildOwnerOutputPath: (uid, job, fn) => `user-outputs/${uid}/${job}/${fn}`,
    buildPublicPath: (sid, fn) => `public/${sid}/${fn}`,
}));

describe('Storage path builders', () => {
    it('builds input path under user-uploads', () => {
        const { buildOwnerInputPath } = require('../utils/firebaseUtils');
        const p = buildOwnerInputPath('u1', 'file.png');
        expect(p).toBe('user-uploads/u1/file.png');
    });
    it('builds output path under user-outputs', () => {
        const { buildOwnerOutputPath } = require('../utils/firebaseUtils');
        const p = buildOwnerOutputPath('u1', 'j1', 'out.jpg');
        expect(p).toBe('user-outputs/u1/j1/out.jpg');
    });
    it('builds public path under public', () => {
        const { buildPublicPath } = require('../utils/firebaseUtils');
        const p = buildPublicPath('abcd1234', 'out.jpg');
        expect(p).toBe('public/abcd1234/out.jpg');
    });
});
