using Microsoft.EntityFrameworkCore;
using School.Infrastructure;

namespace School.Application.Reports;

public class ClassReportService
{
    private readonly SchoolDbContext _db;

    public ClassReportService(SchoolDbContext db) => _db = db;

    // One row per class of the school: its name.
    public async Task<IReadOnlyList<ClassReportRow>> BuildAsync(int schoolId, CancellationToken ct)
        => await _db.Classes.AsNoTracking()
            .Where(c => c.SchoolId == schoolId && !c.IsArchived)
            .OrderBy(c => c.Name).ThenBy(c => c.Id)
            .Select(c => new ClassReportRow(c.Id, c.Name, 0, ""))
            .ToListAsync(ct);
}

public record ClassReportRow(int ClassId, string Name, int Students, string Teacher);
