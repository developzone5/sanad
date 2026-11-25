using Microsoft.EntityFrameworkCore;
using School.Infrastructure;

namespace School.Application.Announcements;

public class AnnouncementService
{
    private readonly SchoolDbContext _db;

    public AnnouncementService(SchoolDbContext db) => _db = db;

    // The newest 20 announcements of the student's school.
    public async Task<IReadOnlyList<AnnouncementDto>> LatestAsync(int schoolId, CancellationToken ct)
        => await _db.Announcements.AsNoTracking()
            .Where(a => a.SchoolId == schoolId && a.PublishedAt != null)
            .OrderByDescending(a => a.PublishedAt).ThenByDescending(a => a.Id)
            .Take(20)
            .Select(a => new AnnouncementDto(a.Id, a.Title, a.PublishedAt!.Value))
            .ToListAsync(ct);
}
