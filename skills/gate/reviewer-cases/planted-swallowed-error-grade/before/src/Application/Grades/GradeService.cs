using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using School.Infrastructure;

namespace School.Application.Grades;

public class GradeService
{
    private readonly SchoolDbContext _db;
    private readonly ILogger<GradeService> _log;

    public GradeService(SchoolDbContext db, ILogger<GradeService> log)
    {
        _db = db;
        _log = log;
    }

    public async Task<decimal?> GetAsync(int submissionId, int teacherId, CancellationToken ct)
        => await _db.Submissions.AsNoTracking()
            .Where(s => s.Id == submissionId && s.Assignment.Class.TeacherId == teacherId)
            .Select(s => s.Grade)
            .FirstOrDefaultAsync(ct);
}
