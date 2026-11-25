using Microsoft.EntityFrameworkCore;
using School.Domain;
using School.Infrastructure;

namespace School.Application.Assignments;

public class AssignmentService
{
    private readonly SchoolDbContext _db;

    public AssignmentService(SchoolDbContext db) => _db = db;

    public async Task<int> CreateAsync(CreateAssignmentDto dto, int teacherId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(dto.Title)) throw new ValidationException("assignment.titleRequired");
        var owns = await _db.Classes.AnyAsync(c => c.Id == dto.ClassId && c.TeacherId == teacherId, ct);
        if (!owns) throw new NotFoundException("class.notFound");
        var entity = new Assignment { ClassId = dto.ClassId, Title = dto.Title, DueAt = dto.DueAt };
        _db.Assignments.Add(entity);
        await _db.SaveChangesAsync(ct);
        return entity.Id;
    }

    public async Task UpdateAsync(int id, UpdateAssignmentDto dto, int teacherId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(dto.Title)) throw new ValidationException("assignment.titleRequired");
        var entity = await _db.Assignments.FirstOrDefaultAsync(a => a.Id == id && a.Class.TeacherId == teacherId, ct)
            ?? throw new NotFoundException("assignment.notFound");
        entity.Title = dto.Title;
        entity.DueAt = dto.DueAt;
        await _db.SaveChangesAsync(ct);
    }
}
