using Microsoft.EntityFrameworkCore;
using School.Domain;
using School.Infrastructure;

namespace School.Application.Courses;

public class EnrollmentService
{
    private readonly SchoolDbContext _db;

    public EnrollmentService(SchoolDbContext db) => _db = db;

    public async Task<int> SeatsLeftAsync(int courseId, CancellationToken ct)
    {
        var course = await _db.Courses.AsNoTracking().FirstOrDefaultAsync(c => c.Id == courseId, ct)
            ?? throw new NotFoundException("course.notFound");
        var taken = await _db.Enrollments.CountAsync(e => e.CourseId == courseId, ct);
        return Math.Max(course.Capacity - taken, 0);
    }
}
