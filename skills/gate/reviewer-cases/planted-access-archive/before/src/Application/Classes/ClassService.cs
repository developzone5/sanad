using Microsoft.EntityFrameworkCore;
using School.Domain;
using School.Infrastructure;

namespace School.Application.Classes;

public class ClassService : IClassService
{
    private readonly SchoolDbContext _db;

    public ClassService(SchoolDbContext db) => _db = db;

    public async Task<PagedResult<ClassDto>> ListAsync(IReadOnlyCollection<int> schoolIds, int page, CancellationToken ct)
    {
        var query = _db.Classes.AsNoTracking()
            .Where(c => schoolIds.Contains(c.SchoolId) && !c.IsArchived)
            .OrderBy(c => c.Id);
        var total = await query.CountAsync(ct);
        var items = await query.Skip((page - 1) * 20).Take(20)
            .Select(c => new ClassDto(c.Id, c.Name, c.SchoolId))
            .ToListAsync(ct);
        return new PagedResult<ClassDto>(items, total);
    }

    public async Task<ClassDto> CreateAsync(CreateClassDto dto, IReadOnlyCollection<int> schoolIds, CancellationToken ct)
    {
        if (!schoolIds.Contains(dto.SchoolId)) throw new ForbiddenException("class.schoolNotAllowed");
        var entity = new SchoolClass { Name = dto.Name.Trim(), SchoolId = dto.SchoolId };
        _db.Classes.Add(entity);
        await _db.SaveChangesAsync(ct);
        return new ClassDto(entity.Id, entity.Name, entity.SchoolId);
    }

    public async Task UpdateAsync(int id, UpdateClassDto dto, IReadOnlyCollection<int> schoolIds, CancellationToken ct)
    {
        var entity = await _db.Classes.FirstOrDefaultAsync(c => c.Id == id && schoolIds.Contains(c.SchoolId), ct)
            ?? throw new NotFoundException("class.notFound");
        entity.Name = dto.Name.Trim();
        await _db.SaveChangesAsync(ct);
    }
}
